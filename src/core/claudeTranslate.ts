// Pure translation of Claude Agent SDK messages (`SDKMessage` live stream /
// `SessionMessage` history) into the ACP-shaped `SessionUpdate`s consumed by
// the localModel reducers. No SDK import — shapes are read structurally and
// malformed input never throws.

import type { PromptUsage, SessionUpdate, StopReason } from './localModel';

export type TranslateOptions = { streaming: boolean };

export type TranslateResult = {
  updates: SessionUpdate[];
  finish?: { stopReason: StopReason; error?: string; usage?: PromptUsage };
  init?: { model: string | null; permissionMode: string | null; cwd: string | null };
};

export const TOOL_RESULT_TEXT_MAX = 2000;
export const ERROR_TEXT_MAX = 500;
const TITLE_COMMAND_MAX = 120;

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function firstLine(text: string, max: number): string {
  const line = text.split(/\r?\n/, 1)[0]?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Human title for a tool call card: the command, file basename, pattern, url… */
export function toolCallTitle(name: string, input: Record<string, unknown>): string {
  const field = (key: string) => str(input[key]);
  if (name === 'Bash') {
    const command = field('command');
    return command ? firstLine(command, TITLE_COMMAND_MAX) || 'Bash' : 'Bash';
  }
  if (FILE_TOOLS.has(name)) {
    const path = field('file_path') ?? field('notebook_path');
    return path ? `${name} ${basename(path)}` : name;
  }
  if (name === 'Grep' || name === 'Glob') {
    const pattern = field('pattern');
    return pattern ? `${name} ${pattern}` : name;
  }
  if (name === 'Task') return field('description') ?? 'Task';
  if (name === 'WebFetch') {
    const url = field('url');
    return url ? `Fetch ${url}` : 'Fetch';
  }
  if (name === 'WebSearch') {
    const query = field('query');
    return query ? `Search ${query}` : 'Search';
  }
  if (name === 'TodoWrite') return 'Update todos';
  return name;
}

/** ACP tool kind for a Claude tool name (read | edit | execute | search | fetch | think | other). */
export function toolCallKind(name: string): string {
  switch (name) {
    case 'Read':
    case 'LS':
      return 'read';
    case 'Grep':
    case 'Glob':
      return 'search';
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'edit';
    case 'Bash':
      return 'execute';
    case 'WebFetch':
    case 'WebSearch':
      return 'fetch';
    case 'Task':
      return 'think';
    default:
      return 'other';
  }
}

/** File locations touched by a tool call; `undefined` for non-file tools. */
export function toolCallLocations(
  name: string,
  input: Record<string, unknown>,
): Array<{ path: string; line?: number | null }> | undefined {
  if (!FILE_TOOLS.has(name)) return undefined;
  const path = str(input.file_path) ?? str(input.notebook_path);
  return path ? [{ path }] : undefined;
}

function contentBlocks(content: unknown): Rec[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.map(rec).filter((block): block is Rec => block !== null);
}

function blocksText(content: unknown): string {
  return contentBlocks(content)
    .filter((block) => block.type === 'text')
    .map((block) => str(block.text) ?? '')
    .join('\n');
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

function sanitiseError(text: string): string {
  return truncate(text.replace(ANSI, '').replace(/\s+/g, ' ').trim(), ERROR_TEXT_MAX);
}

function toolCallUpdate(block: Rec): SessionUpdate | null {
  const id = str(block.id);
  const name = str(block.name);
  if (!id || !name) return null;
  const input = rec(block.input) ?? {};
  const locations = toolCallLocations(name, input);
  return {
    sessionUpdate: 'tool_call',
    toolCallId: id,
    title: toolCallTitle(name, input),
    kind: toolCallKind(name),
    status: 'in_progress',
    rawInput: input,
    ...(locations ? { locations } : {}),
  };
}

function textChunk(
  kind: 'agent_message_chunk' | 'agent_thought_chunk' | 'user_message_chunk',
  text: string,
  messageId: string | undefined,
): SessionUpdate {
  return {
    sessionUpdate: kind,
    content: { type: 'text', text },
    ...(messageId ? { messageId } : {}),
  };
}

function translateStreamEvent(msg: Rec, opts: TranslateOptions): TranslateResult {
  if (!opts.streaming || msg.parent_tool_use_id != null) return { updates: [] };
  const event = rec(msg.event);
  if (!event || event.type !== 'content_block_delta') return { updates: [] };
  const delta = rec(event.delta);
  if (!delta) return { updates: [] };
  if (delta.type === 'text_delta') {
    const text = str(delta.text);
    return { updates: text ? [textChunk('agent_message_chunk', text, undefined)] : [] };
  }
  if (delta.type === 'thinking_delta') {
    const thinking = str(delta.thinking);
    return { updates: thinking ? [textChunk('agent_thought_chunk', thinking, undefined)] : [] };
  }
  return { updates: [] };
}

function translateAssistant(msg: Rec, opts: TranslateOptions): TranslateResult {
  const message = rec(msg.message);
  if (!message) return { updates: [] };
  const blocks = contentBlocks(message.content);
  const parent = str(msg.parent_tool_use_id);
  const updates: SessionUpdate[] = [];
  if (parent) {
    for (const block of blocks) {
      if (block.type !== 'tool_use') continue;
      const name = str(block.name);
      if (!name) continue;
      updates.push({
        sessionUpdate: 'tool_call_update',
        toolCallId: parent,
        content: [
          {
            type: 'content',
            content: { type: 'text', text: `↳ ${toolCallTitle(name, rec(block.input) ?? {})}` },
          },
        ],
      });
    }
    return { updates };
  }
  const messageId = str(msg.uuid) ?? str(message.id) ?? undefined;
  for (const block of blocks) {
    if (block.type === 'tool_use') {
      const update = toolCallUpdate(block);
      if (update) updates.push(update);
    } else if (opts.streaming) {
      continue;
    } else if (block.type === 'text') {
      const text = str(block.text);
      if (text) updates.push(textChunk('agent_message_chunk', text, messageId));
    } else if (block.type === 'thinking') {
      const thinking = str(block.thinking);
      if (thinking) updates.push(textChunk('agent_thought_chunk', thinking, messageId));
    }
  }
  return { updates };
}

function translateUser(msg: Rec, opts: TranslateOptions): TranslateResult {
  if (msg.parent_tool_use_id != null) return { updates: [] };
  const message = rec(msg.message);
  if (!message) return { updates: [] };
  const updates: SessionUpdate[] = [];
  const plainAllowed = !opts.streaming && !msg.isSynthetic && !msg.isMeta;
  const messageId = str(msg.uuid) ?? undefined;
  for (const block of contentBlocks(message.content)) {
    if (block.type === 'tool_result') {
      const toolCallId = str(block.tool_use_id);
      if (!toolCallId) continue;
      const text = truncate(blocksText(block.content), TOOL_RESULT_TEXT_MAX);
      updates.push({
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: block.is_error === true ? 'failed' : 'completed',
        rawOutput: block.content,
        ...(text ? { content: [{ type: 'content', content: { type: 'text', text } }] } : {}),
      });
    } else if (block.type === 'text' && plainAllowed) {
      const text = str(block.text);
      if (text) updates.push(textChunk('user_message_chunk', text, messageId));
    }
  }
  return { updates };
}

function translateResult(msg: Rec): TranslateResult {
  const subtype = str(msg.subtype) ?? 'error';
  const raw = rec(msg.usage) ?? {};
  const input = num(raw.input_tokens);
  const output = num(raw.output_tokens);
  const cachedRead = num(raw.cache_read_input_tokens);
  const cachedWrite = num(raw.cache_creation_input_tokens);
  const usage: PromptUsage = {
    inputTokens: input,
    outputTokens: output,
    cachedReadTokens: cachedRead,
    cachedWriteTokens: cachedWrite,
    totalTokens: input !== null && output !== null ? input + output : null,
  };
  const updates: SessionUpdate[] = [];
  const size = Object.values(rec(msg.modelUsage) ?? {}).reduce<number>(
    (max, entry) => Math.max(max, num(rec(entry)?.contextWindow) ?? 0),
    0,
  );
  if (size > 0) {
    updates.push({
      sessionUpdate: 'usage_update',
      used: (input ?? 0) + (cachedRead ?? 0) + (cachedWrite ?? 0),
      size,
    });
  }
  if (subtype === 'success') return { updates, finish: { stopReason: 'end_turn', usage } };
  if (subtype === 'error_max_turns') return { updates, finish: { stopReason: 'max_turn_requests', usage } };
  if (subtype === 'error_during_execution') {
    const errors = Array.isArray(msg.errors) ? msg.errors.map(str).filter((e): e is string => !!e) : [];
    const text = sanitiseError(errors[0] ?? str(msg.result) ?? '') || subtype;
    return { updates, finish: { stopReason: 'error', error: text, usage } };
  }
  return { updates, finish: { stopReason: 'error', error: subtype, usage } };
}

/**
 * Translate one SDK message into reducer updates plus an optional turn
 * `finish` (from `result`) or `init` (from `system/init`).
 *
 * - `streaming: true` (live `query()` with `includePartialMessages`): text and
 *   thinking come from `stream_event` deltas; the full `assistant` message only
 *   contributes `tool_use` blocks and plain `user` text is dropped (already in
 *   state from `startPrompt`).
 * - `streaming: false` (history): text/thinking/user text are read from the
 *   full messages with `messageId` = the message uuid.
 * - Subagent `assistant` messages (`parent_tool_use_id !== null`) fold each
 *   `tool_use` into a `tool_call_update` on the parent with a single
 *   `↳ <title>` content item. The reducer replaces `content`, so the host must
 *   accumulate these per parent and send the full array. Subagent `user`
 *   messages and text/thinking are dropped.
 * - Stateless: stream deltas carry no `messageId`, so they continue the open
 *   agent message; separation between API messages is up to the host.
 */
export function translateSdkMessage(msg: unknown, opts: TranslateOptions): TranslateResult {
  const m = rec(msg);
  if (!m) return { updates: [] };
  switch (m.type) {
    case 'system':
      if (m.subtype === 'init') {
        return {
          updates: [],
          init: { model: str(m.model), permissionMode: str(m.permissionMode), cwd: str(m.cwd) },
        };
      }
      if (m.subtype === 'compact_boundary') {
        return {
          updates: [
            textChunk('agent_message_chunk', '_Context compacted_', `compact-${str(m.uuid) ?? ''}`),
          ],
        };
      }
      return { updates: [] };
    case 'stream_event':
      return translateStreamEvent(m, opts);
    case 'assistant':
      return translateAssistant(m, opts);
    case 'user':
      return translateUser(m, opts);
    case 'result':
      return translateResult(m);
    default:
      return { updates: [] };
  }
}
