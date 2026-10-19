import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type InitializeResponse,
  type RequestPermissionOutcome,
  type RequestPermissionRequest,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import {
  INSTALL_GUIDANCE,
  applyUpdate,
  clearPermission,
  emptyLocalState,
  finishPrompt,
  newSession as newSessionEntry,
  resetHistory,
  sessionsFor,
  setPermission,
  setTerminalOwned,
  startPrompt,
  titleFromPrompt,
  upsertAgent,
  upsertSession,
  removeSession as removeSessionEntry,
  removeWorkspace as removeWorkspaceEntry,
  type AgentCapabilities,
  type LocalSession,
  type LocalState,
  type SessionUpdate,
  type StopReason,
} from '../../core/localModel';
import { LinkScanner, type PrLinkContext } from '../../core/prLinks';
import { isWslHost, LOCAL_HOST, type ExecHost } from '../../core/execHost';
import type { LocalSessionSummary } from '../../shared/ipc';
import { log } from '../log';
import { hosts } from '../hosts';
import { getLocalState, replaceLocalState, update } from './localState';

const INITIALIZE_TIMEOUT_MS = 60_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

type Deferred = { promise: Promise<never>; reject: (error: Error) => void };

function deferred(): Deferred {
  let reject!: (error: Error) => void;
  const promise = new Promise<never>((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  // Nobody may ever race against this; keep it from surfacing as unhandled.
  promise.catch(() => undefined);
  return { promise, reject };
}

type PendingPermission = {
  sessionId: string;
  resolve: (outcome: RequestPermissionOutcome) => void;
};

type AgentHandle = {
  workspace: string;
  child: ChildProcess | null;
  connection: ClientSideConnection | null;
  ready: Promise<void> | null;
  generation: number;
  backoffMs: number;
  nextRestartAt: number;
  exit: Deferred;
  remoteToUi: Map<string, string>;
  pendingPermissions: Map<string, PendingPermission>;
  capabilities: AgentCapabilities;
};

type SessionBinding = { workspace: string; remoteId: string; generation: number };

type IndexEntry = { id: string; workspace: string; title: string; createdAt: string };

export type HostCommand = { file: string; args: string[] };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const nowIso = () => new Date().toISOString();

// The terminal handoff restarts the workspace agent (the CLI lock is
// process-wide) — refused while any session in the workspace is busy.
export class TerminalHandoffRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalHandoffRefused';
  }
}

// Rejected on handle.exit when the agent is restarted deliberately —
// in-flight prompts resolve 'cancelled' instead of 'error'.
class AgentRestarted extends Error {
  constructor(reason: string) {
    super(`agent restarted: ${reason}`);
    this.name = 'AgentRestarted';
  }
}

// Text worth PR-link scanning from a session update: agent message chunks and
// tool call titles/content/rawOutput. Never user_message_chunk.
function collectAgentOutputText(update: Record<string, unknown>, kind: string): string[] {
  const texts: string[] = [];
  if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
    const content = update.content as { text?: unknown } | undefined;
    if (typeof content?.text === 'string') texts.push(content.text);
  } else if (kind === 'tool_call' || kind === 'tool_call_update') {
    if (typeof update.title === 'string') texts.push(update.title);
    if (Array.isArray(update.content)) {
      for (const block of update.content as Array<{
        text?: unknown;
        content?: { text?: unknown };
      }>) {
        if (typeof block?.text === 'string') texts.push(block.text);
        else if (typeof block?.content?.text === 'string') texts.push(block.content.text);
      }
    }
    if (typeof update.rawOutput === 'string') texts.push(update.rawOutput);
  }
  return texts;
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, operation: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(
      () => rejectPromise(new Error(`${operation} timed out after ${milliseconds}ms`)),
      milliseconds,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

// Resolve the `devin` executable: explicit override, else PATH lookup via
// `where` (Windows) / `which` (POSIX). Returns null when nothing is found.
export function resolveDevinPath(override: string | null | undefined): string | null {
  if (override) return existsSync(override) ? override : null;
  const lookup = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    const result = spawnSync(lookup, ['devin'], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) return null;
    const first = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return first && existsSync(first) ? first : null;
  } catch {
    return null;
  }
}

export interface DevinLocalHostOptions {
  userData: string;
  appPath: string;
  testMode: boolean;
  devinPathOverride: string | null | undefined;
  workspaces: string[];
  onWorkspacesChanged: (workspaces: string[]) => void;
  // Called with each never-before-seen PR URL found in agent output (chat
  // only — user messages and pty output are not scanned here).
  onPullRequestUrl?: (url: string, sessionId: string) => void;
  prLinkContext?: PrLinkContext;
}

export class DevinLocalHost {
  private readonly agents = new Map<string, AgentHandle>();
  private readonly bindings = new Map<string, SessionBinding>();
  private readonly indexFile: string;
  private index: IndexEntry[] = [];
  private workspaces: string[];
  private readonly linkScanners = new Map<string, LinkScanner>();
  private readonly command: HostCommand | null;
  private disposed = false;

  constructor(private readonly options: DevinLocalHostOptions) {
    this.indexFile = join(options.userData, 'local-sessions.json');
    this.workspaces = [...options.workspaces];
    this.command = this.resolveCommand();
    this.index = this.loadIndex();
    replaceLocalState(emptyLocalState(this.command ? this.command.file : null));
    for (const workspace of this.workspaces) {
      update((state) =>
        upsertAgent(state, workspace, {
          status: this.command ? 'stopped' : 'missing-cli',
          ...(this.command ? {} : { error: INSTALL_GUIDANCE }),
        }),
      );
    }
    log('local', 'host-created', {
      detail: {
        cli: this.command?.file ?? null,
        testCommand: Boolean(this.options.testMode && process.env.DEVIN_WORKSPACES_LOCAL_AGENT_CMD),
        workspaces: this.workspaces.length,
      },
    });
  }

  // The production path spawns the external `devin` binary (RunAsNode is fused
  // off, so we never fork Node). A full command override exists only in test mode.
  private resolveCommand(): HostCommand | null {
    const testCommand = this.options.testMode ? process.env.DEVIN_WORKSPACES_LOCAL_AGENT_CMD : undefined;
    if (testCommand) {
      const [file, ...args] = testCommand.split(/\s+/).filter(Boolean);
      if (!file) return null;
      const resolvedArgs = args.map((arg) => {
        if (isAbsolute(arg)) return arg;
        const candidate = resolve(this.options.appPath, arg);
        return existsSync(candidate) ? candidate : arg;
      });
      return { file, args: resolvedArgs };
    }
    const devinPath = resolveDevinPath(this.options.devinPathOverride);
    return devinPath ? { file: devinPath, args: ['acp'] } : null;
  }

  get cliPath(): string | null {
    return this.command?.file ?? null;
  }

  // ---- exec hosts ----

  /** The exec host a workspace path belongs to (UNC → wsl, else local). */
  private hostFor(workspace: string): ExecHost {
    return hosts().hostById(hosts().pathHostId(workspace)) ?? LOCAL_HOST;
  }

  /** Workspace path in the form the agent expects (linux for wsl hosts). */
  private agentCwd(workspace: string): string {
    const host = this.hostFor(workspace);
    return isWslHost(host) ? hosts().hostPath(host, workspace) : workspace;
  }

  // ---- workspaces ----

  listWorkspaces(): string[] {
    return [...this.workspaces];
  }

  // Settings-driven order (local:workspaceReorder); agent handles are keyed
  // by path so only the array order matters.
  syncWorkspaces(workspaces: string[]): void {
    this.workspaces = [...workspaces];
  }

  addWorkspace(path: string): string {
    const normalized = resolve(path);
    if (!this.workspaces.includes(normalized)) {
      this.workspaces.push(normalized);
      this.options.onWorkspacesChanged(this.listWorkspaces());
    }
    update((state) =>
      state.agents[normalized]
        ? state
        : upsertAgent(state, normalized, {
            status: this.command ? 'stopped' : 'missing-cli',
            ...(this.command ? {} : { error: INSTALL_GUIDANCE }),
          }),
    );
    log('local', 'workspace-add', { detail: { workspace: normalized } });
    // Warm the agent so capabilities show up without a first prompt.
    void this.ensureAgent(normalized).catch(() => undefined);
    return normalized;
  }

  removeWorkspace(path: string): void {
    const normalized = resolve(path);
    this.workspaces = this.workspaces.filter((entry) => entry !== normalized && entry !== path);
    this.options.onWorkspacesChanged(this.listWorkspaces());
    const handle = this.agents.get(normalized);
    if (handle) {
      this.agents.delete(normalized);
      this.stopChild(handle);
    }
    for (const [sessionId, binding] of this.bindings) {
      if (binding.workspace === normalized) this.bindings.delete(sessionId);
    }
    for (const sessionId of [...this.linkScanners.keys()]) {
      if (getLocalState().sessions[sessionId]?.workspace === normalized) {
        this.linkScanners.delete(sessionId);
      }
    }
    update((state) => removeWorkspaceEntry(state, normalized));
    log('local', 'workspace-remove', { detail: { workspace: normalized } });
  }

  // ---- agent lifecycle ----

  async ensureAgent(workspace: string): Promise<AgentHandle> {
    if (this.disposed) throw new Error('local host disposed');
    const execHost = this.hostFor(workspace);
    if (isWslHost(execHost)) {
      // Prime probe + env capture before checking devin presence.
      await hosts().shellEnv(execHost);
      if (!hosts().status(execHost.id)?.devin.path) {
        const message = `${execHost.distro}: ${INSTALL_GUIDANCE}`;
        update((state) => upsertAgent(state, workspace, { status: 'missing-cli', error: message }));
        throw new Error(message);
      }
    } else if (!this.command) {
      update((state) => upsertAgent(state, workspace, { status: 'missing-cli', error: INSTALL_GUIDANCE }));
      throw new Error(INSTALL_GUIDANCE);
    }
    let handle = this.agents.get(workspace);
    if (!handle) {
      handle = {
        workspace,
        child: null,
        connection: null,
        ready: null,
        generation: 0,
        backoffMs: BACKOFF_MIN_MS,
        nextRestartAt: 0,
        exit: deferred(),
        remoteToUi: new Map(),
        pendingPermissions: new Map(),
        capabilities: { loadSession: false, sessionList: false, sessionDelete: false },
      };
      this.agents.set(workspace, handle);
    }
    if (handle.ready) {
      await handle.ready;
      return handle;
    }
    const wait = handle.nextRestartAt - Date.now();
    if (wait > 0) {
      update((state) => upsertAgent(state, workspace, { retryInMs: wait }));
      await new Promise((resolveDelay) => setTimeout(resolveDelay, wait));
      if (handle.ready) {
        await handle.ready;
        return handle;
      }
    }
    handle.ready = this.start(handle);
    await handle.ready;
    return handle;
  }

  private async start(handle: AgentHandle): Promise<void> {
    const { workspace } = handle;
    const execHost = this.hostFor(workspace);
    const command = isWslHost(execHost) ? null : this.command;
    if (!isWslHost(execHost) && !command) throw new Error(INSTALL_GUIDANCE);
    handle.generation += 1;
    const generation = handle.generation;
    handle.exit = deferred();
    handle.remoteToUi.clear();
    update((state) => upsertAgent(state, workspace, { status: 'starting', error: undefined, retryInMs: undefined }));
    log('local', 'agent-start', { detail: { workspace, generation, file: command?.file ?? null, host: execHost.id } });

    let child: ChildProcess;
    if (isWslHost(execHost)) {
      // Through `wsl.exe -d D --cd <linux ws> -e /usr/bin/env …` so the agent
      // runs inside the distro with the captured shell env.
      await hosts().shellEnv(execHost);
      child = hosts().spawnOn(execHost, {
        file: hosts().status(execHost.id)?.devin.path ?? 'devin',
        args: ['acp'],
        cwd: hosts().hostPath(execHost, workspace),
      });
    } else {
      child = spawn(command!.file, command!.args, {
        cwd: workspace,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    }
    handle.child = child;
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      const text = chunk.trimEnd();
      // F5: stderr content can carry secrets — log length only.
      if (text) log('local', 'agent-stderr', { detail: { workspace, length: text.length } });
    });
    child.on('error', (error) => {
      log('local', 'agent-spawn-error', { detail: { workspace, message: errorMessage(error) } });
      this.onExit(handle, generation, null, null, errorMessage(error));
    });
    child.on('exit', (code, signal) => this.onExit(handle, generation, code, signal, null));

    if (!child.stdin || !child.stdout) {
      throw new Error('agent process has no stdio');
    }
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    const client: Client = {
      sessionUpdate: async (params) => this.onSessionUpdate(handle, params),
      requestPermission: (params) => this.onRequestPermission(handle, params),
    };
    const connection = new ClientSideConnection(() => client, stream);
    handle.connection = connection;

    let response: InitializeResponse;
    try {
      response = await Promise.race([
        withTimeout(
          connection.initialize({
            protocolVersion: 1,
            clientInfo: { name: 'devin-workspaces', version: '0.1.0' },
            clientCapabilities: {},
          }),
          INITIALIZE_TIMEOUT_MS,
          'initialize',
        ),
        handle.exit.promise,
      ]);
    } catch (error) {
      const message = errorMessage(error);
      log('local', 'agent-initialize-error', { detail: { workspace, message } });
      handle.ready = null;
      if (handle.child === child && child.exitCode === null && child.signalCode === null) {
        this.stopChild(handle);
      }
      update((state) => upsertAgent(state, workspace, { status: 'crashed', error: message }));
      throw error;
    }
    handle.capabilities = {
      loadSession: response.agentCapabilities?.loadSession === true,
      sessionList: Boolean(response.agentCapabilities?.sessionCapabilities?.list),
      sessionDelete: Boolean(response.agentCapabilities?.sessionCapabilities?.delete),
    };
    update((state) =>
      upsertAgent(state, workspace, {
        status: 'ready',
        protocolVersion: response.protocolVersion,
        capabilities: handle.capabilities,
        agentName: response.agentInfo?.name ?? undefined,
        error: undefined,
        retryInMs: undefined,
      }),
    );
    // ux2: the sidebar lists every workspace up front — list once the agent
    // is ready (capabilities.sessionList may still arrive via a later update).
    void this.listSessions(workspace).catch(() => undefined);
    log('local', 'agent-ready', {
      detail: {
        workspace,
        generation,
        protocolVersion: response.protocolVersion,
        capabilities: handle.capabilities,
        agent: response.agentInfo?.name ?? null,
      },
    });
  }

  private onExit(
    handle: AgentHandle,
    generation: number,
    code: number | null,
    signal: NodeJS.Signals | null,
    spawnError: string | null,
  ): void {
    if (handle.generation !== generation) return;
    const { workspace } = handle;
    const stillTracked = this.agents.get(workspace) === handle;
    const reason = spawnError ?? `agent exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`;
    handle.child = null;
    handle.connection = null;
    handle.ready = null;
    handle.exit.reject(new Error(reason));
    handle.exit = deferred();
    handle.remoteToUi.clear();
    for (const [, pending] of handle.pendingPermissions) {
      pending.resolve({ outcome: 'cancelled' });
    }
    handle.pendingPermissions.clear();
    const crashed = stillTracked && !this.disposed;
    if (crashed) {
      handle.nextRestartAt = Date.now() + handle.backoffMs;
      handle.backoffMs = Math.min(handle.backoffMs * 2, BACKOFF_MAX_MS);
    }
    update((state) => {
      let next = state;
      for (const session of sessionsFor(state, workspace)) {
        if (session.running)
          next = finishPrompt(next, session.id, 'error', { error: reason, now: nowIso() });
        else if (session.pendingPermission) next = clearPermission(next, session.id);
      }
      if (!stillTracked) return next;
      const agent = state.agents[workspace];
      return upsertAgent(next, workspace, {
        status: this.disposed ? 'stopped' : 'crashed',
        error: this.disposed ? undefined : reason,
        restarts: (agent?.restarts ?? 0) + (crashed ? 1 : 0),
        retryInMs: crashed ? handle.nextRestartAt - Date.now() : undefined,
      });
    });
    log('local', 'agent-exit', { detail: { workspace, generation, code, signal, reason } });
  }

  // Restart the workspace agent without crash bookkeeping — used for the
  // terminal handoff, where the CLI's per-session lock is only released when
  // the acp process exits.
  async restartAgent(workspace: string, reason: string): Promise<void> {
    const normalized = resolve(workspace);
    const handle = this.agents.get(normalized);
    if (!handle) return;
    // Bump the generation first so the imminent onExit is a no-op.
    handle.generation += 1;
    handle.remoteToUi.clear();
    for (const [, pending] of handle.pendingPermissions) {
      pending.resolve({ outcome: 'cancelled' });
    }
    handle.pendingPermissions.clear();
    for (const [sessionId, binding] of this.bindings) {
      if (binding.workspace === normalized) this.bindings.delete(sessionId);
    }
    const child = handle.child;
    const exited = new Promise<void>((resolveExit) => {
      if (!child || child.exitCode !== null || child.signalCode !== null) {
        resolveExit();
        return;
      }
      const timer = setTimeout(resolveExit, 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolveExit();
      });
    });
    update((state) => {
      let next = state;
      for (const session of sessionsFor(state, normalized)) {
        if (session.running) {
          next = finishPrompt(next, session.id, 'cancelled', { now: nowIso() });
        } else if (session.pendingPermission) {
          next = clearPermission(next, session.id);
        }
      }
      return upsertAgent(next, normalized, { status: 'starting' });
    });
    log('local', 'agent-restart', { detail: { workspace: normalized, reason } });
    this.stopChild(handle);
    await exited;
    handle.child = null;
    handle.connection = null;
    handle.backoffMs = BACKOFF_MIN_MS;
    handle.nextRestartAt = 0;
    handle.exit.reject(new AgentRestarted(reason));
    handle.exit = deferred();
    handle.ready = this.start(handle);
    await handle.ready;
  }

  // Terminal handoff: mark the session owned by its `devin -r` pty and release
  // the CLI lock by restarting the workspace agent (the lock lives in-process).
  // Refused while any session in the workspace is busy — the restart would
  // cancel it mid-turn.
  async releaseSessionForTerminal(sessionId: string): Promise<void> {
    const session = getLocalState().sessions[sessionId];
    if (!session) return;
    const busy = sessionsFor(getLocalState(), session.workspace).filter(
      (entry) => entry.running || entry.pendingPermission,
    );
    if (busy.length > 0) {
      throw new TerminalHandoffRefused(
        busy.length === 1 && busy[0]!.id === sessionId
          ? 'This session is still running — wait for it to finish or cancel it before opening the terminal.'
          : 'A session in this workspace is still running — wait for it to finish or cancel it before opening the terminal.',
      );
    }
    update((state) => setTerminalOwned(state, sessionId, true));
    const handle = this.agents.get(session.workspace);
    if (handle?.child && this.bindings.has(sessionId)) {
      await this.restartAgent(session.workspace, 'terminal-handoff');
    }
  }

  // The terminal closed: hand the session back to chat, reloading fresh history
  // (which now includes the turns made in the terminal).
  async reclaimSessionFromTerminal(sessionId: string): Promise<void> {
    update((state) => setTerminalOwned(state, sessionId, false));
    // The session may have been deleted (or its workspace removed) while the
    // pty was alive — re-check after every await and bail silently.
    const live = () => {
      const session = getLocalState().sessions[sessionId];
      return session && this.agents.has(session.workspace) ? session : null;
    };
    if (!live() || this.disposed) return;
    try {
      const session = live()!;
      const handle = await this.ensureAgent(session.workspace);
      if (!live() || this.disposed) return;
      if (handle.capabilities.loadSession) {
        // The pty process may still be releasing the lock — `session/load`
        // fails session_locked (retryable) while it drains.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            await this.loadSession(session.workspace, sessionId);
            break;
          } catch (error) {
            const kind = (error as { data?: Record<string, unknown> }).data?.[
              'cognition.ai/errorKind'
            ];
            if (kind !== 'session_locked' || attempt === 2) throw error;
            await new Promise((resolve) => setTimeout(resolve, 500));
            if (!live() || this.disposed) return;
          }
        }
      }
    } catch (error) {
      log('local', 'session-reclaim-error', {
        detail: { sessionId, message: errorMessage(error) },
      });
    }
  }

  private stopChild(handle: AgentHandle): void {
    const child = handle.child;
    if (!child) return;
    try {
      child.stdin?.end();
    } catch {
      // ignore
    }
    const forceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 1500);
    child.once('exit', () => clearTimeout(forceTimer));
    child.kill();
  }

  // Test-only: expose the agent's pid so an E2E test can kill it externally.
  agentPid(workspace: string): number | null {
    return this.agents.get(resolve(workspace))?.child?.pid ?? null;
  }

  private scanForPrLinks(sessionId: string, text: string): void {
    let scanner = this.linkScanners.get(sessionId);
    if (!scanner) {
      scanner = new LinkScanner({ context: this.options.prLinkContext ?? {} });
      this.linkScanners.set(sessionId, scanner);
    }
    for (const url of scanner.scan(text)) {
      this.options.onPullRequestUrl?.(url, sessionId);
    }
  }

  // Prompt settled — a URL deferred at a chunk boundary may still be pending.
  private flushPrLinks(sessionId: string): void {
    const scanner = this.linkScanners.get(sessionId);
    if (!scanner) return;
    for (const url of scanner.flush()) {
      this.options.onPullRequestUrl?.(url, sessionId);
    }
  }

  // ---- ACP client callbacks ----

  private onSessionUpdate(handle: AgentHandle, params: SessionNotification): void {
    const sessionId = handle.remoteToUi.get(params.sessionId) ?? params.sessionId;
    const kind = params.update.sessionUpdate;
    if (kind === 'tool_call' || kind === 'tool_call_update' || kind === 'plan') {
      log('local', 'session-update', { detail: { sessionId, kind } });
    }
    if (kind === 'usage_update') {
      const usage = params.update as { used?: unknown; size?: unknown };
      log('local', 'session-update', {
        detail: {
          sessionId,
          kind,
          used: typeof usage.used === 'number' ? usage.used : null,
          size: typeof usage.size === 'number' ? usage.size : null,
        },
      });
    }
    if (this.options.onPullRequestUrl) {
      for (const text of collectAgentOutputText(params.update as unknown as Record<string, unknown>, kind)) {
        this.scanForPrLinks(sessionId, text);
      }
    }
    update((state) => applyUpdate(state, sessionId, params.update as unknown as SessionUpdate));
  }

  private onRequestPermission(
    handle: AgentHandle,
    params: RequestPermissionRequest,
  ): Promise<{ outcome: RequestPermissionOutcome }> {
    const sessionId = handle.remoteToUi.get(params.sessionId) ?? params.sessionId;
    const requestId = randomUUID();
    log('local', 'permission-request', {
      detail: { sessionId, requestId, toolCallId: params.toolCall.toolCallId, options: params.options.length },
    });
    // The agent may introduce the tool call inside the permission request itself.
    update((state) =>
      applyUpdate(state, sessionId, {
        ...(params.toolCall as unknown as Record<string, unknown>),
        sessionUpdate: 'tool_call_update',
      } as unknown as SessionUpdate),
    );
    return new Promise((resolvePermission) => {
      handle.pendingPermissions.set(requestId, {
        sessionId,
        resolve: (outcome) => {
          handle.pendingPermissions.delete(requestId);
          update((state) => clearPermission(state, sessionId));
          resolvePermission({ outcome });
        },
      });
      update((state) =>
        setPermission(state, sessionId, {
          requestId,
          toolCallId: params.toolCall.toolCallId,
          title: params.toolCall.title ?? state.sessions[sessionId]?.toolCalls[params.toolCall.toolCallId]?.title ?? 'Permission required',
          options: params.options.map((option) => ({
            optionId: option.optionId,
            name: option.name,
            kind: option.kind,
          })),
        }),
      );
    });
  }

  resolvePermission(sessionId: string, requestId: string, optionId: string): void {
    const session = getLocalState().sessions[sessionId];
    if (!session) throw new Error('unknown session');
    const handle = this.agents.get(session.workspace);
    const pending = handle?.pendingPermissions.get(requestId);
    if (!pending || pending.sessionId !== sessionId) throw new Error('no pending permission request');
    log('local', 'permission-resolved', { detail: { sessionId, requestId, optionId } });
    pending.resolve({ outcome: 'selected', optionId });
  }

  // ---- sessions ----

  private requireSession(sessionId: string): LocalSession {
    const session = getLocalState().sessions[sessionId];
    if (!session) throw new Error('unknown session');
    return session;
  }

  async newSession(workspace: string): Promise<string> {
    const normalized = resolve(workspace);
    const handle = await this.ensureAgent(normalized);
    const connection = handle.connection;
    if (!connection) throw new Error('agent not connected');
    const response = await Promise.race([
      withTimeout(
        connection.newSession({ cwd: this.agentCwd(normalized), mcpServers: [] }),
        INITIALIZE_TIMEOUT_MS,
        'session/new',
      ),
      handle.exit.promise,
    ]);
    const createdAt = new Date().toISOString();
    const session = newSessionEntry({
      id: response.sessionId,
      workspace: normalized,
      createdAt,
      historySource: handle.capabilities.sessionList ? 'agent' : 'local-index',
      loaded: true,
    });
    update((state) => upsertSession(state, session));
    this.bindings.set(session.id, {
      workspace: normalized,
      remoteId: response.sessionId,
      generation: handle.generation,
    });
    this.index.push({ id: session.id, workspace: normalized, title: '', createdAt });
    this.saveIndex();
    log('local', 'session-new', { detail: { workspace: normalized, sessionId: session.id } });
    return session.id;
  }

  // Make sure the UI session is attached to the current agent generation,
  // replaying history (loadSession) or re-creating a remote session after a crash.
  private async bind(handle: AgentHandle, session: LocalSession): Promise<SessionBinding> {
    if (session.terminalOwned) throw new Error('session is open in the Terminal tab');
    const connection = handle.connection;
    if (!connection) throw new Error('agent not connected');
    const existing = this.bindings.get(session.id);
    if (existing && existing.generation === handle.generation) return existing;
    if (handle.capabilities.loadSession) {
      update((state) => resetHistory(state, session.id));
      await Promise.race([
        withTimeout(
          connection.loadSession({
            sessionId: session.id,
            cwd: this.agentCwd(session.workspace),
            mcpServers: [],
          }),
          INITIALIZE_TIMEOUT_MS,
          'session/load',
        ),
        handle.exit.promise,
      ]);
      const binding = { workspace: session.workspace, remoteId: session.id, generation: handle.generation };
      this.bindings.set(session.id, binding);
      log('local', 'session-rebound', { detail: { sessionId: session.id, via: 'load' } });
      return binding;
    }
    if (!existing) throw new Error('history not supported by agent');
    // Crash recovery without loadSession: fresh remote session, UI history kept.
    const response = await Promise.race([
      withTimeout(
        connection.newSession({ cwd: this.agentCwd(session.workspace), mcpServers: [] }),
        INITIALIZE_TIMEOUT_MS,
        'session/new',
      ),
      handle.exit.promise,
    ]);
    handle.remoteToUi.set(response.sessionId, session.id);
    const binding = { workspace: session.workspace, remoteId: response.sessionId, generation: handle.generation };
    this.bindings.set(session.id, binding);
    log('local', 'session-rebound', { detail: { sessionId: session.id, via: 'new', remoteId: response.sessionId } });
    return binding;
  }

  async prompt(sessionId: string, text: string): Promise<StopReason> {
    const session = this.requireSession(sessionId);
    if (session.terminalOwned) throw new Error('session is open in the Terminal tab');
    if (session.running) throw new Error('a prompt is already running in this session');
    const handle = await this.ensureAgent(session.workspace);
    const binding = await this.bind(handle, this.requireSession(sessionId));
    const connection = handle.connection;
    if (!connection) throw new Error('agent not connected');
    update((state) => startPrompt(state, sessionId, text, nowIso()));
    const entry = this.index.find((item) => item.id === sessionId);
    if (entry && !entry.title) {
      entry.title = titleFromPrompt(text);
      this.saveIndex();
    }
    log('local', 'prompt-start', { detail: { sessionId, length: text.length } });
    try {
      const response = await Promise.race([
        connection.prompt({ sessionId: binding.remoteId, prompt: [{ type: 'text', text }] }),
        handle.exit.promise,
      ]);
      const stopReason = response.stopReason as StopReason;
      handle.backoffMs = BACKOFF_MIN_MS;
      update((state) =>
        finishPrompt(state, sessionId, stopReason, {
          now: nowIso(),
          usage: response.usage ?? undefined,
        }),
      );
      this.flushPrLinks(sessionId);
      log('local', 'prompt-finish', { detail: { sessionId, stopReason } });
      return stopReason;
    } catch (error) {
      if (error instanceof AgentRestarted) {
        // restartAgent already finished this prompt as cancelled — a terminal
        // handoff is not a prompt failure.
        log('local', 'prompt-finish', { detail: { sessionId, stopReason: 'cancelled' } });
        return 'cancelled';
      }
      const message = errorMessage(error);
      update((state) => finishPrompt(state, sessionId, 'error', { error: message, now: nowIso() }));
      this.flushPrLinks(sessionId);
      log('local', 'prompt-error', { detail: { sessionId, message } });
      throw error;
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    if (session.terminalOwned) throw new Error('session is open in the Terminal tab');
    const handle = this.agents.get(session.workspace);
    const binding = this.bindings.get(sessionId);
    if (!handle?.connection || !binding) return;
    for (const [requestId, pending] of handle.pendingPermissions) {
      if (pending.sessionId === sessionId) {
        handle.pendingPermissions.delete(requestId);
        pending.resolve({ outcome: 'cancelled' });
      }
    }
    update((state) => clearPermission(state, sessionId));
    log('local', 'cancel', { detail: { sessionId } });
    await handle.connection.cancel({ sessionId: binding.remoteId });
  }

  // Deletes the agent's persistent session (the id returned by session/new or
  // session/list — never a crash-rebind remoteId). Requires
  // sessionCapabilities.delete; running prompts must be cancelled first.
  async deleteSession(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    if (session.running) throw new Error('cancel the running prompt before deleting');
    const handle = await this.ensureAgent(session.workspace);
    if (!handle.capabilities.sessionDelete) throw new Error('delete not supported by agent');
    const connection = handle.connection;
    if (!connection) throw new Error('agent not connected');
    for (const [requestId, pending] of handle.pendingPermissions) {
      if (pending.sessionId === sessionId) {
        handle.pendingPermissions.delete(requestId);
        pending.resolve({ outcome: 'cancelled' });
      }
    }
    await Promise.race([
      withTimeout(
        connection.deleteSession({ sessionId: session.id }),
        INITIALIZE_TIMEOUT_MS,
        'session/delete',
      ),
      handle.exit.promise,
    ]);
    this.bindings.delete(sessionId);
    this.linkScanners.delete(sessionId);
    for (const [remoteId, uiId] of handle.remoteToUi) {
      if (uiId === sessionId) handle.remoteToUi.delete(remoteId);
    }
    this.index = this.index.filter((entry) => entry.id !== sessionId);
    this.saveIndex();
    update((state) => removeSessionEntry(state, sessionId));
    log('local', 'session-delete', { detail: { workspace: session.workspace, sessionId } });
  }

  // Deletes every session of a workspace. Running prompts are cancelled first
  // (the user confirmed the bulk action in the panel); failures on one session
  // don't stop the rest. Returns the ids that were deleted.
  async deleteWorkspaceSessions(
    workspace: string,
  ): Promise<{ deleted: string[]; cancelled: number; failed: number }> {
    const normalized = resolve(workspace);
    const ids = Object.values(getLocalState().sessions)
      .filter((session) => session.workspace === normalized)
      .map((session) => session.id);
    const deleted: string[] = [];
    let cancelled = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        if (getLocalState().sessions[id]?.running) {
          await this.cancel(id);
          cancelled += 1;
          // running flips when the cancelled prompt resolves — bounded wait.
          const deadline = Date.now() + 5_000;
          while (getLocalState().sessions[id]?.running && Date.now() < deadline) {
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
          }
        }
        await this.deleteSession(id);
        deleted.push(id);
      } catch {
        failed += 1;
      }
    }
    log('local', 'session-delete-all', {
      detail: {
        workspace: normalized,
        requested: ids.length,
        deleted: deleted.length,
        cancelled,
        failed,
      },
    });
    return { deleted, cancelled, failed };
  }

  async listSessions(workspace: string): Promise<LocalSessionSummary[]> {
    const normalized = resolve(workspace);
    let handle: AgentHandle | null = null;
    try {
      handle = await this.ensureAgent(normalized);
    } catch {
      handle = null;
    }
    if (handle?.connection && handle.capabilities.sessionList) {
      const response = await Promise.race([
        withTimeout(
          handle.connection.listSessions({ cwd: this.agentCwd(normalized) }),
          INITIALIZE_TIMEOUT_MS,
          'session/list',
        ),
        handle.exit.promise,
      ]);
      update((state) => {
        let next = state;
        for (const info of response.sessions) {
          const meta = (info._meta ?? {}) as Record<string, unknown>;
          const createdAt =
            (typeof meta['cognition.ai/createdAt'] === 'string' ? meta['cognition.ai/createdAt'] : null) ??
            info.updatedAt ??
            new Date().toISOString();
          next = upsertSession(
            next,
            newSessionEntry({
              id: info.sessionId,
              workspace: normalized,
              title: info.title ?? '',
              createdAt,
              historySource: 'agent',
              loaded: false,
            }),
          );
        }
        return next;
      });
      log('local', 'session-list', { detail: { workspace: normalized, source: 'agent', count: response.sessions.length } });
    } else {
      const entries = this.index.filter((entry) => entry.workspace === normalized);
      update((state) => {
        let next = state;
        for (const entry of entries) {
          next = upsertSession(
            next,
            newSessionEntry({
              id: entry.id,
              workspace: normalized,
              title: entry.title,
              createdAt: entry.createdAt,
              historySource: 'local-index',
              loaded: false,
            }),
          );
        }
        return next;
      });
      log('local', 'session-list', { detail: { workspace: normalized, source: 'local-index', count: entries.length } });
    }
    return sessionsFor(getLocalState(), normalized).map((session) => ({
      id: session.id,
      workspace: session.workspace,
      title: session.title,
      createdAt: session.createdAt,
      historySource: session.historySource,
    }));
  }

  async loadSession(workspace: string, sessionId: string): Promise<void> {
    const normalized = resolve(workspace);
    const existing = getLocalState().sessions[sessionId];
    if (existing?.terminalOwned) throw new Error('session is open in the Terminal tab');
    const handle = await this.ensureAgent(normalized);
    if (!handle.capabilities.loadSession) throw new Error('history not supported by agent');
    const connection = handle.connection;
    if (!connection) throw new Error('agent not connected');
    update((state) => {
      const next = state.sessions[sessionId]
        ? state
        : upsertSession(
            state,
            newSessionEntry({ id: sessionId, workspace: normalized, historySource: 'agent', loaded: false }),
          );
      return resetHistory(next, sessionId);
    });
    await Promise.race([
      withTimeout(
        connection.loadSession({
          sessionId,
          cwd: this.agentCwd(normalized),
          mcpServers: [],
        }),
        INITIALIZE_TIMEOUT_MS,
        'session/load',
      ),
      handle.exit.promise,
    ]);
    this.bindings.set(sessionId, { workspace: normalized, remoteId: sessionId, generation: handle.generation });
    log('local', 'session-load', { detail: { workspace: normalized, sessionId } });
  }

  // ---- local index (fallback history) ----

  private loadIndex(): IndexEntry[] {
    if (!existsSync(this.indexFile)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.indexFile, 'utf8')) as { sessions?: unknown };
      if (!raw || !Array.isArray(raw.sessions)) return [];
      return raw.sessions.filter(
        (entry): entry is IndexEntry =>
          Boolean(entry) &&
          typeof entry === 'object' &&
          typeof (entry as IndexEntry).id === 'string' &&
          typeof (entry as IndexEntry).workspace === 'string' &&
          typeof (entry as IndexEntry).createdAt === 'string',
      ).map((entry) => ({ ...entry, title: typeof entry.title === 'string' ? entry.title : '' }));
    } catch (error) {
      log('local', 'index-load-failed', { detail: { message: errorMessage(error) } });
      return [];
    }
  }

  private saveIndex(): void {
    const temporary = `${this.indexFile}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ sessions: this.index }), 'utf8');
      renameSync(temporary, this.indexFile);
    } catch (error) {
      log('local', 'index-save-failed', { detail: { message: errorMessage(error) } });
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const handle of this.agents.values()) this.stopChild(handle);
    this.agents.clear();
  }
}

export type { LocalState };
