// Pure reducers for the Devin Local (ACP) surface. No electron, no SDK runtime
// imports — the update shapes below are structurally compatible with ACP v1
// `session/update` notifications from `@agentclientprotocol/sdk`.

export type Block =
  | { type: 'text'; text: string }
  | { type: 'thought'; text: string }
  | { type: 'tool_call'; id: string };

export type Message = { role: 'user' | 'agent'; blocks: Block[]; messageId?: string };

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export type ToolCall = {
  id: string;
  title: string;
  kind?: string;
  status: ToolCallStatus;
  content?: unknown[];
  locations?: Array<{ path: string; line?: number | null }>;
  rawInput?: unknown;
  rawOutput?: unknown;
};

export type PlanEntry = {
  content: string;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'completed';
};

export type PermissionOption = { optionId: string; name: string; kind: string };

export type PendingPermission = {
  requestId: string;
  toolCallId: string;
  title: string;
  options: PermissionOption[];
};

export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled'
  | 'error';

export type HistorySource = 'agent' | 'local-index';

// ACP `SessionModeState` subset — ids/names only, never _meta.
export type SessionModes = {
  currentModeId: string;
  availableModes: Array<{ id: string; name: string }>;
};

// Cumulative token/context usage for a session — fed by `usage_update` updates
// and PromptResponse.usage (experimental ACP field). `used`/`size` are context
// window numbers; the token fields are cumulative across turns.
export type SessionUsage = {
  used: number | null;
  size: number | null;
  totalTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  thoughtTokens: number | null;
  cachedReadTokens: number | null;
  cachedWriteTokens: number | null;
  costUsd: number | null;
};

// Subset of the SDK's experimental `Usage` carried by a prompt response.
export type PromptUsage = {
  totalTokens?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  thoughtTokens?: number | null;
  cachedReadTokens?: number | null;
  cachedWriteTokens?: number | null;
  costUsd?: number | null;
};

export function emptyUsage(): SessionUsage {
  return {
    used: null,
    size: null,
    totalTokens: null,
    inputTokens: null,
    outputTokens: null,
    thoughtTokens: null,
    cachedReadTokens: null,
    cachedWriteTokens: null,
    costUsd: null,
  };
}

// Agent-neutral chat session: everything the chat view renders. `LocalSession`
// and the Claude chat session extend it with their own metadata.
export type ChatSession = {
  id: string;
  title: string;
  createdAt: string;
  messages: Message[];
  plan?: PlanEntry[];
  toolCalls: Record<string, ToolCall>;
  pendingPermission?: PendingPermission;
  running: boolean;
  lastStopReason?: StopReason;
  // The session's `devin -r` pty owns the CLI's per-session lock — chat is
  // disabled until the terminal closes (see acpHost.releaseSessionForTerminal).
  terminalOwned?: boolean;
  // ISO stamp of the in-flight prompt; drives the thinking indicator.
  promptStartedAt?: string;
  lastTurnMs?: number;
  usage?: SessionUsage;
  error?: string;
  historySource: HistorySource;
  loaded: boolean;
  // ACP session modes advertised by session/new|load; the list is
  // agent-defined. Absent when the agent doesn't advertise modes.
  modes?: SessionModes;
};

export type LocalSession = ChatSession & { workspace: string };

// Minimal state shape the generic reducers operate on; the concrete session
// type (`S['sessions'][string]`) is preserved by spreading.
export type ChatStateLike = { sessions: Record<string, ChatSession> };

type SessionOf<S extends ChatStateLike> = S['sessions'][string];

export type AgentStatus = 'missing-cli' | 'starting' | 'ready' | 'crashed' | 'stopped';

export type AgentCapabilities = {
  loadSession: boolean;
  sessionList: boolean;
  sessionDelete: boolean;
};

export type LocalAgent = {
  workspace: string;
  status: AgentStatus;
  protocolVersion?: number;
  capabilities?: AgentCapabilities;
  agentName?: string;
  error?: string;
  restarts: number;
  retryInMs?: number;
};

export type LocalState = {
  cliPath: string | null;
  installGuidance: string;
  agents: Record<string, LocalAgent>;
  sessions: Record<string, LocalSession>;
};

export const INSTALL_GUIDANCE =
  'The Devin CLI was not found on PATH. Install it from https://docs.devin.ai/desktop and restart Devin Workspaces, or set local.devinPath in settings.json.';

export function emptyLocalState(cliPath: string | null = null): LocalState {
  return { cliPath, installGuidance: cliPath ? '' : INSTALL_GUIDANCE, agents: {}, sessions: {} };
}

// ---- ACP update shapes (structural subset of the SDK types) ----

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data?: string; mimeType?: string }
  | { type: 'audio'; data?: string; mimeType?: string }
  | { type: 'resource_link'; uri: string; name?: string }
  | { type: 'resource'; resource: unknown };

type ContentChunk = { content: ContentBlock; messageId?: string | null };

type ToolCallUpdateFields = {
  toolCallId: string;
  title?: string | null;
  kind?: string | null;
  status?: ToolCallStatus | null;
  content?: unknown[] | null;
  // When true, `content` appends to the existing array instead of replacing
  // it (subagent folds send each new block as it arrives).
  appendContent?: boolean;
  locations?: Array<{ path: string; line?: number | null }> | null;
  rawInput?: unknown;
  rawOutput?: unknown;
};

export type SessionUpdate =
  | (ContentChunk & { sessionUpdate: 'user_message_chunk' })
  | (ContentChunk & { sessionUpdate: 'agent_message_chunk' })
  | (ContentChunk & { sessionUpdate: 'agent_thought_chunk' })
  | (ToolCallUpdateFields & { sessionUpdate: 'tool_call' })
  | (ToolCallUpdateFields & { sessionUpdate: 'tool_call_update' })
  | { sessionUpdate: 'plan'; entries: PlanEntry[] }
  | { sessionUpdate: 'session_info_update'; title?: string | null }
  | { sessionUpdate: 'current_mode_update'; currentModeId: string }
  | {
      sessionUpdate: 'usage_update';
      used: number;
      size: number;
      _meta?: Record<string, unknown> | null;
    }
  | { sessionUpdate: string; [key: string]: unknown };

export const TITLE_MAX = 60;

export function titleFromPrompt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX - 1)}…` : flat;
}

export function newChatSession(
  input: Pick<ChatSession, 'id'> &
    Partial<Pick<ChatSession, 'title' | 'createdAt' | 'historySource' | 'loaded'>>,
): ChatSession {
  return {
    id: input.id,
    title: input.title ?? '',
    createdAt: input.createdAt ?? new Date().toISOString(),
    messages: [],
    toolCalls: {},
    running: false,
    historySource: input.historySource ?? 'agent',
    loaded: input.loaded ?? true,
  };
}

export function newSession(
  input: Pick<LocalSession, 'id' | 'workspace'> &
    Partial<Pick<LocalSession, 'title' | 'createdAt' | 'historySource' | 'loaded'>>,
): LocalSession {
  return { ...newChatSession(input), workspace: input.workspace };
}

function contentText(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'image':
      return '[image]';
    case 'audio':
      return '[audio]';
    case 'resource_link':
      return block.name ? `[${block.name}](${block.uri})` : block.uri;
    case 'resource':
      return '[resource]';
    default:
      return '';
  }
}

function replaceSession<S extends ChatStateLike>(state: S, session: SessionOf<S>): S {
  return { ...state, sessions: { ...state.sessions, [session.id]: session } };
}

// Append a text-ish block to the message stream: continue the last message when
// the role (and messageId, if provided) match, otherwise start a new message.
function appendChunk<T extends ChatSession>(
  session: T,
  role: Message['role'],
  block: Block,
  messageId?: string | null,
): T {
  const messages = [...session.messages];
  const last = messages[messages.length - 1];
  // Agent chunks continue the open agent message unless the messageId changes.
  // User chunks (replays) only merge when they share an explicit messageId, so
  // each replayed prompt becomes its own message.
  const sameMessage =
    last &&
    last.role === role &&
    (role === 'user'
      ? Boolean(messageId) && last.messageId === messageId
      : !messageId || !last.messageId || last.messageId === messageId);
  if (!sameMessage) {
    messages.push({ role, blocks: [block], ...(messageId ? { messageId } : {}) });
    return { ...session, messages };
  }
  const blocks = [...last.blocks];
  const tail = blocks[blocks.length - 1];
  if (tail && block.type !== 'tool_call' && tail.type === block.type) {
    blocks[blocks.length - 1] = { type: tail.type, text: `${tail.text}${block.text}` } as Block;
  } else {
    blocks.push(block);
  }
  messages[messages.length - 1] = {
    ...last,
    blocks,
    ...(messageId && !last.messageId ? { messageId } : {}),
  };
  return { ...session, messages };
}

function mergeToolCall(existing: ToolCall | undefined, update: ToolCallUpdateFields): ToolCall {
  const base: ToolCall = existing ?? {
    id: update.toolCallId,
    title: update.title ?? update.toolCallId,
    status: 'pending',
  };
  return {
    ...base,
    ...(update.title != null ? { title: update.title } : {}),
    ...(update.kind != null ? { kind: update.kind } : {}),
    ...(update.status != null ? { status: update.status } : {}),
    ...(update.content != null
      ? {
          content: update.appendContent
            ? [...(base.content ?? []), ...update.content]
            : update.content,
        }
      : {}),
    ...(update.locations != null ? { locations: update.locations } : {}),
    ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
    ...(update.rawOutput !== undefined ? { rawOutput: update.rawOutput } : {}),
  };
}

export function applyUpdate<S extends ChatStateLike>(
  state: S,
  sessionId: string,
  update: SessionUpdate,
): S {
  const session = state.sessions[sessionId] as SessionOf<S> | undefined;
  if (!session) return state;
  switch (update.sessionUpdate) {
    case 'user_message_chunk': {
      // While a prompt is running the user message already came from startPrompt;
      // agents that echo the prompt live would otherwise duplicate it. Replays
      // (session/load) happen with running === false and are kept.
      if (session.running) return state;
      const chunk = update as ContentChunk;
      const text = contentText(chunk.content);
      let next = appendChunk(session, 'user', { type: 'text', text }, chunk.messageId);
      if (!next.title && text.trim()) next = { ...next, title: titleFromPrompt(text) };
      return replaceSession(state, next);
    }
    case 'agent_message_chunk': {
      const chunk = update as ContentChunk;
      return replaceSession(
        state,
        appendChunk(session, 'agent', { type: 'text', text: contentText(chunk.content) }, chunk.messageId),
      );
    }
    case 'agent_thought_chunk': {
      const chunk = update as ContentChunk;
      return replaceSession(
        state,
        appendChunk(session, 'agent', { type: 'thought', text: contentText(chunk.content) }, chunk.messageId),
      );
    }
    case 'tool_call': {
      const call = update as ToolCallUpdateFields;
      const merged = mergeToolCall(session.toolCalls[call.toolCallId], call);
      const withCall = { ...session, toolCalls: { ...session.toolCalls, [merged.id]: merged } };
      const alreadyReferenced = session.toolCalls[call.toolCallId] !== undefined;
      return replaceSession(
        state,
        alreadyReferenced ? withCall : appendChunk(withCall, 'agent', { type: 'tool_call', id: merged.id }),
      );
    }
    case 'tool_call_update': {
      const call = update as ToolCallUpdateFields;
      const existing = session.toolCalls[call.toolCallId];
      const merged = mergeToolCall(existing, call);
      const withCall = { ...session, toolCalls: { ...session.toolCalls, [merged.id]: merged } };
      return replaceSession(
        state,
        existing ? withCall : appendChunk(withCall, 'agent', { type: 'tool_call', id: merged.id }),
      );
    }
    case 'plan': {
      const plan = update as { entries: PlanEntry[] };
      return replaceSession(state, { ...session, plan: plan.entries.map((entry) => ({ ...entry })) });
    }
    case 'session_info_update': {
      const info = update as { title?: string | null };
      if (!info.title) return state;
      return replaceSession(state, { ...session, title: info.title });
    }
    case 'current_mode_update': {
      const modeUpdate = update as { currentModeId?: unknown };
      if (typeof modeUpdate.currentModeId !== 'string') return state;
      return replaceSession(state, {
        ...session,
        modes: {
          currentModeId: modeUpdate.currentModeId,
          availableModes: session.modes?.availableModes ?? [],
        },
      });
    }
    case 'usage_update': {
      const usageUpdate = update as { used?: unknown; size?: unknown; _meta?: unknown };
      const usage = { ...(session.usage ?? emptyUsage()) };
      if (typeof usageUpdate.used === 'number') usage.used = usageUpdate.used;
      if (typeof usageUpdate.size === 'number') usage.size = usageUpdate.size;
      const meta =
        usageUpdate._meta && typeof usageUpdate._meta === 'object'
          ? (usageUpdate._meta as Record<string, unknown>)
          : {};
      for (const key of [
        'inputTokens',
        'outputTokens',
        'cachedWriteTokens',
        'cachedReadTokens',
        'thoughtTokens',
      ] as const) {
        const value = meta[`cognition.ai/${key}`];
        if (typeof value === 'number') usage[key] = value;
      }
      if (usage.inputTokens !== null && usage.outputTokens !== null) {
        usage.totalTokens = usage.inputTokens + usage.outputTokens;
      }
      return replaceSession(state, { ...session, usage });
    }
    default:
      return state;
  }
}

export function startPrompt<S extends ChatStateLike>(
  state: S,
  sessionId: string,
  text: string,
  now: string,
): S {
  const session = state.sessions[sessionId] as SessionOf<S> | undefined;
  if (!session) return state;
  const next: SessionOf<S> = {
    ...session,
    messages: [...session.messages, { role: 'user', blocks: [{ type: 'text', text }] }],
    running: true,
    promptStartedAt: now,
    title: session.title || titleFromPrompt(text),
  };
  delete next.lastStopReason;
  delete next.lastTurnMs;
  delete next.error;
  return replaceSession(state, next);
}

export function finishPrompt<S extends ChatStateLike>(
  state: S,
  sessionId: string,
  stopReason: StopReason,
  options: { error?: string; now?: string; usage?: PromptUsage | undefined } = {},
): S {
  const session = state.sessions[sessionId] as SessionOf<S> | undefined;
  if (!session) return state;
  const next: SessionOf<S> = { ...session, running: false, lastStopReason: stopReason };
  delete next.pendingPermission;
  if (options.now && session.promptStartedAt) {
    next.lastTurnMs = Math.max(
      0,
      Date.parse(options.now) - Date.parse(session.promptStartedAt),
    );
  }
  delete next.promptStartedAt;
  const usage = options.usage;
  if (usage) {
    const merged = { ...(session.usage ?? emptyUsage()) };
    for (const key of [
      'totalTokens',
      'inputTokens',
      'outputTokens',
      'thoughtTokens',
      'cachedReadTokens',
      'cachedWriteTokens',
      'costUsd',
    ] as const) {
      const value = usage[key];
      if (typeof value === 'number' && Number.isFinite(value)) merged[key] = value;
    }
    next.usage = merged;
  }
  if (options.error) next.error = options.error;
  else delete next.error;
  return replaceSession(state, next);
}

export function setModes<S extends ChatStateLike>(
  state: S,
  sessionId: string,
  modes: SessionModes,
): S {
  const session = state.sessions[sessionId] as SessionOf<S> | undefined;
  if (!session) return state;
  return replaceSession(state, {
    ...session,
    modes: {
      currentModeId: modes.currentModeId,
      availableModes: modes.availableModes.map((mode) => ({ ...mode })),
    },
  });
}

export function setPermission<S extends ChatStateLike>(
  state: S,
  sessionId: string,
  permission: PendingPermission,
): S {
  const session = state.sessions[sessionId] as SessionOf<S> | undefined;
  if (!session) return state;
  return replaceSession(state, { ...session, pendingPermission: permission });
}

export function clearPermission<S extends ChatStateLike>(state: S, sessionId: string): S {
  const session = state.sessions[sessionId] as SessionOf<S> | undefined;
  if (!session || !session.pendingPermission) return state;
  const next = { ...session };
  delete next.pendingPermission;
  return replaceSession(state, next);
}

export function setTerminalOwned<S extends ChatStateLike>(
  state: S,
  sessionId: string,
  owned: boolean,
): S {
  const session = state.sessions[sessionId] as SessionOf<S> | undefined;
  if (!session) return state;
  const next = { ...session };
  if (owned) {
    next.terminalOwned = true;
    // No in-flight chat survives the handoff.
    next.running = false;
    delete next.pendingPermission;
    delete next.promptStartedAt;
  } else {
    delete next.terminalOwned;
  }
  return replaceSession(state, next);
}

export function resetHistory<S extends ChatStateLike>(state: S, sessionId: string): S {
  const session = state.sessions[sessionId] as SessionOf<S> | undefined;
  if (!session) return state;
  const next: SessionOf<S> = { ...session, messages: [], toolCalls: {}, loaded: true };
  delete next.plan;
  return replaceSession(state, next);
}

export function upsertSession<S extends ChatStateLike>(state: S, session: SessionOf<S>): S {
  const existing = state.sessions[session.id] as SessionOf<S> | undefined;
  if (!existing) return replaceSession(state, session);
  // Listing never clobbers already-streamed content; it only refreshes metadata.
  return replaceSession(state, {
    ...existing,
    title: existing.title || session.title,
    createdAt: existing.createdAt || session.createdAt,
    historySource: session.historySource,
  });
}

export type AgentPatch = {
  [K in keyof Omit<LocalAgent, 'workspace'>]?: Omit<LocalAgent, 'workspace'>[K] | undefined;
};

export function upsertAgent(
  state: LocalState,
  workspace: string,
  patch: AgentPatch,
): LocalState {
  const existing: LocalAgent = state.agents[workspace] ?? {
    workspace,
    status: 'starting',
    restarts: 0,
  };
  const next: LocalAgent = { ...existing };
  for (const [key, value] of Object.entries(patch) as [keyof AgentPatch, unknown][]) {
    if (value === undefined) delete (next as Record<string, unknown>)[key];
    else (next as Record<string, unknown>)[key] = value;
  }
  return { ...state, agents: { ...state.agents, [workspace]: next } };
}

export function removeSession<S extends ChatStateLike>(state: S, sessionId: string): S {
  if (!state.sessions[sessionId]) return state;
  const sessions = { ...state.sessions };
  delete sessions[sessionId];
  return { ...state, sessions };
}

export function removeWorkspace(state: LocalState, workspace: string): LocalState {
  const agents = { ...state.agents };
  delete agents[workspace];
  const sessions = Object.fromEntries(
    Object.entries(state.sessions).filter(([, session]) => session.workspace !== workspace),
  );
  return { ...state, agents, sessions };
}

// Sessions in a workspace, newest first.
export function sessionsFor(state: LocalState, workspace: string): LocalSession[] {
  return Object.values(state.sessions)
    .filter((session) => session.workspace === workspace)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}
