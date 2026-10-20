// ClaudeHost: one streaming-input SDK `query()` per live chat session. The
// query is created lazily on the first prompt (resume when the transcript is
// already on disk, sessionId for in-memory new sessions), kept open across
// turns so interrupt()/setPermissionMode()/setModel() work, and closed after
// `claude.keepAliveMinutes` idle or LRU eviction at `claude.maxLiveAgents`.
// Logs carry ids/counts/durations only — never prompt or output text.

import { randomUUID } from 'node:crypto';
import type {
  ClaudeChatSessionPublic,
  ClaudePermissionMode,
} from '../../shared/ipc';
import type {
  ChatSession,
  Message,
  PromptUsage,
  SessionUpdate,
  StopReason,
} from '../../core/localModel';
import {
  applyUpdate,
  clearPermission,
  finishPrompt,
  newChatSession,
  removeSession,
  resetHistory,
  setPermission,
  setTerminalOwned,
  startPrompt,
  upsertSession,
} from '../../core/localModel';
import { LinkScanner } from '../../core/prLinks';
import {
  messageIdFromStreamEvent,
  toolCallTitle,
  translateSdkMessage,
} from '../../core/claudeTranslate';
import { fixtureOrigins, state, testMode } from '../state';
import { log } from '../log';
import { getChatState, update, type ClaudeChatState } from './chatState';
import { claudeUsage } from './usage';
import { loadSdk } from './sdk';
import { resolveClaudePath } from './claudePath';
import { isWslHost, LOCAL_HOST, type ExecHost, type HostId } from '../../core/execHost';
import { hosts } from '../hosts';

export type ClaudeChatSession = ChatSession & {
  host: HostId;
  cwd: string;
  permissionMode: ClaudePermissionMode;
  model: string | null;
  live: 'idle' | 'starting' | 'live' | 'stopped';
};

/** Keys in `env` that differ from (or are absent in) process.env — the exact
 * additions the SDK made for its child (CLAUDE_* vars). */
function diffEnv(env: Record<string, string | undefined> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value !== undefined && value !== process.env[key]) out[key] = value;
  }
  return out;
}

type SdkUserMessage = {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: string | null;
  session_id?: string;
};

// Simple pushable AsyncIterable: the SDK's streaming `prompt` input.
class PromptQueue implements AsyncIterable<SdkUserMessage> {
  private items: SdkUserMessage[] = [];
  private waiters: Array<(result: IteratorResult<SdkUserMessage>) => void> = [];
  private done = false;

  push(message: SdkUserMessage): void {
    if (this.done) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.items.push(message);
  }

  end(): void {
    this.done = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined as never, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SdkUserMessage> {
    while (true) {
      const item = this.items.shift();
      if (item) {
        yield item;
        continue;
      }
      if (this.done) return;
      const result = await new Promise<IteratorResult<SdkUserMessage>>((resolve) =>
        this.waiters.push(resolve),
      );
      if (result.done) return;
      yield result.value;
    }
  }
}

type LiveQuery = {
  queue: PromptQueue;
  query: unknown;
  abort: AbortController;
  consumer: Promise<void>;
  idleTimer: NodeJS.Timeout | null;
  running: boolean;
  cancelled: boolean;
  lastActivity: number;
};

const DISPOSE_WAIT_MS = 8_000;

export class ClaudeHost {
  private readonly configDir: string;
  private readonly cliPath: () => string | null;
  private readonly isOnDisk: (id: string) => boolean;
  private readonly hostFor: (id: string) => ExecHost;
  private readonly onPullRequestUrl: (sessionId: string, url: string) => void;
  private readonly onEvent: (
    sessionId: string,
    kind: 'waiting' | 'finished' | 'blocked',
    detail?: { tool?: string; error?: string },
  ) => void;
  private readonly live = new Map<string, LiveQuery>();
  // Ids that have ever had a query created — the first uses `sessionId`, but
  // once the SDK wrote its transcript a died-and-restarted query must resume
  // (isOnDisk lags until the next store list).
  private readonly started = new Set<string>();
  // Current API message id per session (message_start → event.message.id) —
  // stamped on stream deltas so consecutive API messages render as separate
  // agent bubbles.
  private readonly currentMessageIds = new Map<string, string | null>();
  private readonly scanners = new Map<string, LinkScanner>();
  private readonly pendingPermissions = new Map<
    string,
    { tool: string; resolve: (result: unknown) => void }
  >();
  private disposed = false;

  constructor(opts: {
    cliPath: () => string | null;
    configDir: string;
    isOnDisk: (id: string) => boolean;
    hostFor?: (id: string) => ExecHost;
    onPullRequestUrl: (sessionId: string, url: string) => void;
    onEvent?: (
      sessionId: string,
      kind: 'waiting' | 'finished' | 'blocked',
      detail?: { tool?: string; error?: string },
    ) => void;
  }) {
    this.cliPath = opts.cliPath;
    this.configDir = opts.configDir;
    this.isOnDisk = opts.isOnDisk;
    this.hostFor = opts.hostFor ?? (() => LOCAL_HOST);
    this.onPullRequestUrl = opts.onPullRequestUrl;
    this.onEvent = opts.onEvent ?? (() => undefined);
  }

  // Chat-derived notification events: finished on end_turn, blocked
  // on any other terminal stop reason except cancelled (never emitted).
  private emitFinish(id: string, stopReason: string, error?: string): void {
    // A turn finished — utilization moved; nudge the usage service (Q4).
    if (stopReason === 'end_turn') claudeUsage().poke('turn');
    if (stopReason === 'end_turn') this.onEvent(id, 'finished');
    else if (stopReason !== 'cancelled') this.onEvent(id, 'blocked', { error: error ?? '' });
  }

  isLive(id: string): boolean {
    return this.live.has(id);
  }

  liveCount(): number {
    return this.live.size;
  }

  isLoaded(id: string): boolean {
    return getChatState().sessions[id]?.loaded === true;
  }

  // Whether a query was ever created for this id (the transcript exists even
  // when the store hasn't re-listed yet) — decides resume vs --session-id.
  hasStarted(id: string): boolean {
    return this.started.has(id);
  }

  setTerminalOwned(id: string, owned: boolean): void {
    update((s) => setTerminalOwned(s, id, owned));
  }

  // Terminal handoff: closes the live query for the session (the pty
  // becomes the writer).
  async closeLiveQuery(id: string): Promise<void> {
    await this.closeLive(id);
  }

  isRunning(id: string): boolean {
    return getChatState().sessions[id]?.running === true;
  }

  newSession(cwd: string, host: HostId = 'local'): string {
    const id = randomUUID();
    const settings = state.settings?.current.claude;
    const session: ClaudeChatSession = {
      ...(newChatSession({ id, loaded: true }) as ChatSession),
      host,
      cwd,
      permissionMode: settings?.defaultPermissionMode ?? 'default',
      model: settings?.model ?? null,
      live: 'idle',
    };
    update((s) => upsertSession(s, session));
    return id;
  }

  ensureSession(id: string, info: { cwd: string | null; host?: HostId }): void {
    const existing = getChatState().sessions[id];
    if (existing) return;
    const session: ClaudeChatSession = {
      ...(newChatSession({ id, loaded: false }) as ChatSession),
      host: info.host ?? 'local',
      cwd: info.cwd ?? '',
      permissionMode: state.settings?.current.claude.defaultPermissionMode ?? 'default',
      model: state.settings?.current.claude.model ?? null,
      live: 'idle',
    };
    update((s) => upsertSession(s, session));
  }

  dropSession(id: string): void {
    void this.closeLive(id);
    this.scanners.delete(id);
    this.currentMessageIds.delete(id);
    update((s) => ({
      ...removeSession(s, id),
      subagentSessions: Object.fromEntries(
        Object.entries(s.subagentSessions).filter(([key]) => !key.startsWith(`${id}/`)),
      ),
    }));
  }

  // Read-only subagent transcript chat state keyed '<sessionId>/<agentId>'
  // never a live query, never prompts.
  ensureSubagentSession(key: string, info: { cwd: string | null; host?: HostId }): void {
    if (getChatState().subagentSessions[key]) return;
    const session: ClaudeChatSession = {
      ...(newChatSession({ id: key, loaded: false }) as ChatSession),
      host: info.host ?? 'local',
      cwd: info.cwd ?? '',
      permissionMode: state.settings?.current.claude.defaultPermissionMode ?? 'default',
      model: null,
      live: 'idle',
    };
    update((s) => ({
      ...s,
      subagentSessions: { ...s.subagentSessions, [key]: session },
    }));
  }

  async loadSubagentHistory(
    key: string,
    parentSessionId: string,
    agentId: string,
  ): Promise<void> {
    const t0 = Date.now();
    const sdk = await loadSdk();
    const messages = (await hosts().withConfigDir(this.hostFor(parentSessionId), () =>
      sdk.getSubagentMessages(parentSessionId, agentId),
    )) as unknown[];
    let count = 0;
    // The generic reducers address `sessions[id]` — run them against a
    // sub-state keyed by the composite id, then merge back.
    let next = { sessions: getChatState().subagentSessions };
    next = resetHistory(next, key);
    for (const msg of messages) {
      const result = translateSdkMessage(msg, { streaming: false });
      for (const u of result.updates) next = applyUpdate(next, key, u) as typeof next;
      if (result.updates.length > 0) count += 1;
      // init data (model/cwd) is redundant here — the synthetic session
      // already carries the parent's cwd; `patch()` only targets `sessions`.
      if (result.finish) {
        next = finishPrompt(next, key, result.finish.stopReason, {
          ...(result.finish.error !== undefined ? { error: result.finish.error } : {}),
          ...(result.finish.usage !== undefined ? { usage: result.finish.usage } : {}),
        }) as typeof next;
      }
    }
    const existing = next.sessions[key];
    const merged = existing ? { ...existing, loaded: true } : existing;
    update((s) => ({
      ...s,
      subagentSessions: merged
        ? { ...s.subagentSessions, [key]: merged }
        : s.subagentSessions,
    }));
    log('claude', 'claude-subagent-history', {
      detail: { sessionId: parentSessionId, count, ms: Date.now() - t0 },
    });
  }

  private patch(id: string, patch: Partial<ClaudeChatSession>): void {
    update((s) => {
      const session = s.sessions[id];
      if (!session) return s;
      return {
        ...s,
        sessions: { ...s.sessions, [id]: { ...session, ...patch } },
      };
    });
  }

  async loadHistory(id: string): Promise<void> {
    const t0 = Date.now();
    const sdk = await loadSdk();
    const messages = (await hosts().withConfigDir(this.hostFor(id), () =>
      sdk.getSessionMessages(id),
    )) as unknown[];
    let count = 0;
    // resetHistory wipes the tool calls — the LinkScanner must reset with it.
    this.scanners.delete(id);
    update((s) => resetHistory(s, id));
    for (const msg of messages) {
      const result = translateSdkMessage(msg, { streaming: false });
      for (const u of result.updates) this.applySessionUpdate(id, u);
      if (result.updates.length > 0) count += 1;
      if (result.init) this.applyInit(id, result.init);
      if (result.finish) {
        const opts: { error?: string; usage?: PromptUsage } = {};
        if (result.finish.error !== undefined) opts.error = result.finish.error;
        if (result.finish.usage !== undefined) opts.usage = result.finish.usage;
        update((s) => finishPrompt(s, id, result.finish!.stopReason, opts));
      }
    }
    this.patch(id, { loaded: true });
    log('claude', 'claude-history', {
      detail: { sessionId: id, count, ms: Date.now() - t0 },
    });
  }

  async prompt(id: string, text: string): Promise<void> {
    const session = getChatState().sessions[id];
    if (!session) throw new Error('unknown claude session');
    update((s) => startPrompt(s, id, text, new Date().toISOString()));
    log('claude', 'claude-prompt', { detail: { sessionId: id, length: text.length } });
    try {
      const liveQuery = await this.ensureLive(id);
      liveQuery.running = true;
      this.resetIdleTimer(id, liveQuery);
      liveQuery.queue.push({
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
        session_id: id,
      });
    } catch (error) {
      update((s) =>
        finishPrompt(s, id, 'error', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  async cancel(id: string): Promise<void> {
    const liveQuery = this.live.get(id);
    if (!liveQuery) return;
    liveQuery.cancelled = true;
    try {
      await (liveQuery.query as { interrupt(): Promise<unknown> }).interrupt();
    } catch {
      // The consumer loop's throw path finishes the turn as cancelled/error.
    }
  }

  respondPermission(id: string, requestId: string, optionId: string): void {
    const pending = this.pendingPermissions.get(`${id}:${requestId}`);
    if (!pending) return;
    this.pendingPermissions.delete(`${id}:${requestId}`);
    update((s) => clearPermission(s, id));
    if (optionId === 'allow') {
      pending.resolve({ behavior: 'allow' });
    } else if (optionId === 'allow_always') {
      pending.resolve({ behavior: 'allow', allowAlways: true });
    } else {
      pending.resolve({ behavior: 'deny', message: 'Denied in Devin Workspaces' });
    }
    log('claude', 'claude-permission', {
      detail: { sessionId: id, tool: pending.tool, decision: optionId },
    });
  }

  async setPermissionMode(id: string, mode: ClaudePermissionMode): Promise<void> {
    this.patch(id, { permissionMode: mode });
    const liveQuery = this.live.get(id);
    if (liveQuery) {
      await (liveQuery.query as { setPermissionMode(m: string): Promise<void> })
        .setPermissionMode(mode)
        .catch(() => undefined);
    }
  }

  async setModel(id: string, model: string | null): Promise<void> {
    this.patch(id, { model });
    const liveQuery = this.live.get(id);
    if (liveQuery) {
      await (liveQuery.query as { setModel(m?: string): Promise<void> })
        .setModel(model ?? undefined)
        .catch(() => undefined);
    }
  }

  // --- live query lifecycle -------------------------------------------------

  private async ensureLive(id: string): Promise<LiveQuery> {
    const existing = this.live.get(id);
    if (existing) return existing;
    this.evictLru();
    const session = getChatState().sessions[id];
    if (!session) throw new Error('unknown claude session');
    this.patch(id, { live: 'starting' });
    const sdk = await loadSdk();
    const queue = new PromptQueue();
    const abort = new AbortController();
    const t0 = Date.now();
    const onDisk = this.isOnDisk(id) || this.started.has(id);
    const execHost = this.hostFor(id);
    if (isWslHost(execHost)) {
      // Prime the §1.4 env cache so spawnOn uses the captured shell env.
      await hosts().shellEnv(execHost);
    }
    const options = {
      cwd: session.cwd || undefined,
      pathToClaudeCodeExecutable:
        (isWslHost(execHost)
          ? (hosts().status(execHost.id)?.claude.path ?? 'claude')
          : this.cliPath()) ?? undefined,
      permissionMode: session.permissionMode,
      model: session.model ?? undefined,
      includePartialMessages: true,
      settingSources: ['user', 'project', 'local'] as string[],
      canUseTool: (toolName: string, input: Record<string, unknown>, opts: unknown) =>
        this.canUseTool(id, toolName, input, opts as {
          signal: AbortSignal;
          suggestions?: unknown[];
          toolUseID?: string;
        }),
      abortController: abort,
      ...(onDisk ? { resume: id } : { sessionId: id }),
      ...(isWslHost(execHost)
        ? {
            // The SDK hands us {command,args,cwd,env,signal}; env is the full
            // Windows env, so only the SDK's own additions are forwarded.
            spawnClaudeCodeProcess: (o: {
              command: string;
              args: string[];
              cwd?: string;
              env?: Record<string, string | undefined>;
              signal: AbortSignal;
            }) =>
              hosts().spawnOn(
                execHost,
                {
                  file: o.command,
                  args: o.args,
                  cwd: o.cwd || session.cwd || '/',
                  env: diffEnv(o.env),
                },
                { signal: o.signal },
              ),
          }
        : {}),
    };
    const q = sdk.query({ prompt: queue, options } as never);
    const liveQuery: LiveQuery = {
      queue,
      query: q,
      abort,
      consumer: Promise.resolve(),
      idleTimer: null,
      running: false,
      cancelled: false,
      lastActivity: Date.now(),
    };
    this.live.set(id, liveQuery);
    this.started.add(id);
    this.patch(id, { live: 'live' });
    log('claude', 'claude-live', { detail: { live: this.live.size, evicted: 0 } });
    liveQuery.consumer = this.consume(id, q as AsyncGenerator<unknown>);
    log('claude', 'claude-query', {
      detail: { sessionId: id, mode: onDisk ? 'resume' : 'new', ms: Date.now() - t0 },
    });
    this.resetIdleTimer(id, liveQuery);
    return liveQuery;
  }

  private evictLru(): void {
    const max = state.settings?.current.claude.maxLiveAgents ?? 3;
    if (this.live.size < max) return;
    // Oldest idle live query loses its slot; running queries are never evicted
    // (an all-running overflow is allowed).
    let oldest: { id: string; at: number } | null = null;
    for (const [id, liveQuery] of this.live) {
      if (liveQuery.running) continue;
      if (!oldest || liveQuery.lastActivity < oldest.at) {
        oldest = { id, at: liveQuery.lastActivity };
      }
    }
    if (!oldest) return;
    void this.closeLive(oldest.id);
    log('claude', 'claude-live', { detail: { live: this.live.size, evicted: 1 } });
  }

  private resetIdleTimer(id: string, liveQuery: LiveQuery): void {
    liveQuery.lastActivity = Date.now();
    if (liveQuery.idleTimer) clearTimeout(liveQuery.idleTimer);
    const minutes = state.settings?.current.claude.keepAliveMinutes ?? 15;
    liveQuery.idleTimer = setTimeout(() => {
      if (!liveQuery.running) void this.closeLive(id);
      else this.resetIdleTimer(id, liveQuery);
    }, minutes * 60_000);
    liveQuery.idleTimer.unref?.();
  }

  private async closeLive(id: string): Promise<void> {
    const liveQuery = this.live.get(id);
    if (!liveQuery) return;
    this.live.delete(id);
    if (liveQuery.idleTimer) clearTimeout(liveQuery.idleTimer);
    liveQuery.queue.end();
    try {
      (liveQuery.query as { close(): void }).close();
    } catch {
      // Already closed.
    }
    // The child exits 2–7 s after close() (Spike A) — bound the wait.
    await Promise.race([
      liveQuery.consumer.catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, DISPOSE_WAIT_MS).unref?.()),
    ]);
    this.patch(id, { live: 'stopped' });
  }

  private async consume(id: string, q: AsyncGenerator<unknown>): Promise<void> {
    const t0 = Date.now();
    try {
      for await (const msg of q) {
        const messageId = messageIdFromStreamEvent(msg);
        if (messageId) this.currentMessageIds.set(id, messageId);
        const result = translateSdkMessage(msg, {
          streaming: true,
          messageId: this.currentMessageIds.get(id) ?? null,
        });
        for (const u of result.updates) this.applySessionUpdate(id, u);
        if (result.init) this.applyInit(id, result.init);
        if (result.finish) {
          this.currentMessageIds.delete(id);
          // The turn's last chunk may leave a PR URL sitting in the
          // scanner's carry (a match ending at text end is deferred).
          const scanner = this.scanners.get(id);
          if (scanner) {
            for (const url of scanner.flush()) this.onPullRequestUrl(id, url);
          }
          const opts: { error?: string; usage?: PromptUsage; now: string } = {
            now: new Date().toISOString(),
          };
          if (result.finish.error !== undefined) opts.error = result.finish.error;
          if (result.finish.usage !== undefined) opts.usage = result.finish.usage;
          update((s) => finishPrompt(s, id, result.finish!.stopReason, opts));
          this.emitFinish(id, result.finish.stopReason, result.finish.error);
          log('claude', 'claude-turn', {
            detail: {
              sessionId: id,
              stopReason: result.finish.stopReason,
              ms: Date.now() - t0,
            },
          });
          const liveQuery = this.live.get(id);
          if (liveQuery) {
            liveQuery.running = false;
            this.resetIdleTimer(id, liveQuery);
          }
        }
      }
      // Clean iterator exit — the query ended on its own. Only a running
      // prompt is finished; an idle query just drops the live marker.
      if (getChatState().sessions[id]?.running) {
        update((s) =>
          finishPrompt(s, id, 'error', {
            error: 'Claude Code exited',
            now: new Date().toISOString(),
          }),
        );
        this.emitFinish(id, 'error', 'Claude Code exited');
      }
      this.live.delete(id);
      this.patch(id, { live: 'stopped' });
    } catch (error) {
      const liveQuery = this.live.get(id);
      const cancelled = liveQuery?.cancelled === true;
      const message = error instanceof Error ? error.message : String(error);
      const running = getChatState().sessions[id]?.running === true;
      if (cancelled) {
        if (running) {
          update((s) =>
            finishPrompt(s, id, 'cancelled', { now: new Date().toISOString() }),
          );
        }
        log('claude', 'claude-turn', {
          detail: { sessionId: id, stopReason: 'cancelled', ms: Date.now() - t0 },
        });
      } else {
        // A close from closeLive (idle/LRU/dispose/drop) throws here too —
        // never mark an idle session as errored.
        if (running) {
          update((s) =>
            finishPrompt(s, id, 'error', {
              error: message.slice(0, 500),
              now: new Date().toISOString(),
            }),
          );
          this.emitFinish(id, 'error', message.slice(0, 200));
        }
        log('claude', 'claude-query-error', {
          detail: { sessionId: id, message: message.slice(0, 200) },
        });
      }
      this.live.delete(id);
      this.patch(id, { live: 'stopped' });
    }
  }

  private applyInit(
    id: string,
    init: { model: string | null; permissionMode: string | null; cwd: string | null },
  ): void {
    const patch: Partial<ClaudeChatSession> = {};
    if (init.model) patch.model = init.model;
    if (init.permissionMode)
      patch.permissionMode = init.permissionMode as ClaudePermissionMode;
    if (init.cwd) patch.cwd = init.cwd;
    if (Object.keys(patch).length > 0) this.patch(id, patch);
  }

  private applySessionUpdate(id: string, update_: SessionUpdate): void {
    // PR links: feed agent text chunks and tool-result text (never prompts).
    let scanner = this.scanners.get(id);
    if (!scanner) {
      scanner = new LinkScanner({ context: { githubOrigins: fixtureOrigins } });
      this.scanners.set(id, scanner);
    }
    for (const text of updateText(update_)) {
      for (const url of scanner.scan(text)) this.onPullRequestUrl(id, url);
    }
    update((s) => applyUpdate(s, id, update_));
  }

  private canUseTool(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal; suggestions?: unknown[]; toolUseID?: string },
  ): Promise<unknown> {
    const requestId = randomUUID();
    const options = opts.suggestions?.length
      ? [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ]
      : [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ];
    update((s) =>
      setPermission(s, sessionId, {
        requestId,
        toolCallId: opts.toolUseID ?? '',
        title: toolCallTitle(toolName, input),
        options,
      }),
    );
    this.onEvent(sessionId, 'waiting', { tool: toolName });
    return new Promise((resolve) => {
      const wrapped = (result: unknown) => {
        opts.signal.removeEventListener('abort', onAbort);
        if (result && typeof result === 'object' && (result as { allowAlways?: boolean }).allowAlways) {
          resolve({
            behavior: 'allow',
            updatedInput: input,
            updatedPermissions: opts.suggestions,
          });
          return;
        }
        if (result && typeof result === 'object' && (result as { behavior?: string }).behavior === 'allow') {
          resolve({ behavior: 'allow', updatedInput: input });
          return;
        }
        resolve(result ?? { behavior: 'deny', message: 'Denied in Devin Workspaces' });
      };
      const onAbort = () => {
        this.pendingPermissions.delete(`${sessionId}:${requestId}`);
        update((s) => clearPermission(s, sessionId));
        resolve({ behavior: 'deny', message: 'Permission request aborted' });
      };
      opts.signal.addEventListener('abort', onAbort, { once: true });
      this.pendingPermissions.set(`${sessionId}:${requestId}`, {
        tool: toolName,
        resolve: wrapped,
      });
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const closers = [...this.live.keys()].map((id) => this.closeLive(id));
    await Promise.race([
      Promise.allSettled(closers),
      new Promise<void>((resolve) => setTimeout(resolve, DISPOSE_WAIT_MS).unref?.()),
    ]);
  }
}

function updateText(update_: SessionUpdate): string[] {
  const u = update_ as Record<string, unknown>;
  const out: string[] = [];
  if (
    update_.sessionUpdate === 'agent_message_chunk' ||
    update_.sessionUpdate === 'agent_thought_chunk'
  ) {
    const content = u.content as { type?: string; text?: string } | undefined;
    if (content?.type === 'text' && typeof content.text === 'string') out.push(content.text);
  }
  if (update_.sessionUpdate === 'tool_call_update' && Array.isArray(u.content)) {
    for (const item of u.content as Array<{ content?: { text?: string } }>) {
      const text = item?.content?.text;
      if (typeof text === 'string') out.push(text);
    }
  }
  return out;
}

let instance: ClaudeHost | null = null;

export function claudeHost(): ClaudeHost {
  instance ??= new ClaudeHost({
    cliPath: () => resolveClaudePath(state.settings?.current.claude.path ?? null),
    configDir: process.env.CLAUDE_CONFIG_DIR?.trim() || '',
    isOnDisk: () => false,
    onPullRequestUrl: () => undefined,
  });
  return instance;
}

export function setClaudeHost(host: ClaudeHost): void {
  instance = host;
}
