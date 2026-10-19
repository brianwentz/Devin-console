import { describe, expect, it } from 'vitest';
import {
  ERROR_TEXT_MAX,
  TOOL_RESULT_TEXT_MAX,
  messageIdFromStreamEvent,
  toolCallKind,
  toolCallLocations,
  toolCallTitle,
  translateSdkMessage,
} from '../../src/core/claudeTranslate';
import {
  applyUpdate,
  finishPrompt,
  newChatSession,
  startPrompt,
  type ChatStateLike,
} from '../../src/core/localModel';

const LIVE = { streaming: true };
const HIST = { streaming: false };
const SID = 's1';

function delta(delta: Record<string, unknown>, parent: string | null = null) {
  return {
    type: 'stream_event',
    uuid: 'ev-1',
    session_id: SID,
    parent_tool_use_id: parent,
    event: { type: 'content_block_delta', index: 0, delta },
  };
}

function assistant(content: unknown, parent: string | null = null, uuid = 'a-1') {
  return {
    type: 'assistant',
    uuid,
    session_id: SID,
    parent_tool_use_id: parent,
    message: { id: 'msg_1', role: 'assistant', model: 'm', content },
  };
}

function user(content: unknown, extra: Record<string, unknown> = {}) {
  return {
    type: 'user',
    uuid: 'u-1',
    session_id: SID,
    parent_tool_use_id: null,
    message: { role: 'user', content },
    ...extra,
  };
}

const USAGE = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 100,
  cache_creation_input_tokens: 20,
};

describe('toolCallTitle / toolCallKind / toolCallLocations', () => {
  it('titles per tool', () => {
    expect(toolCallTitle('Bash', { command: 'git status\n&& more' })).toBe('git status');
    expect(toolCallTitle('Bash', { command: 'x'.repeat(200) })).toHaveLength(120);
    expect(toolCallTitle('Bash', {})).toBe('Bash');
    expect(toolCallTitle('Read', { file_path: 'C:\\repo\\src\\a.ts' })).toBe('Read a.ts');
    expect(toolCallTitle('Edit', { file_path: '/home/u/b.ts' })).toBe('Edit b.ts');
    expect(toolCallTitle('Write', { file_path: 'c.ts' })).toBe('Write c.ts');
    expect(toolCallTitle('MultiEdit', { file_path: 'd/e.ts' })).toBe('MultiEdit e.ts');
    expect(toolCallTitle('NotebookEdit', { notebook_path: 'n/b.ipynb' })).toBe('NotebookEdit b.ipynb');
    expect(toolCallTitle('Read', {})).toBe('Read');
    expect(toolCallTitle('Grep', { pattern: 'foo.*' })).toBe('Grep foo.*');
    expect(toolCallTitle('Glob', { pattern: '**/*.ts' })).toBe('Glob **/*.ts');
    expect(toolCallTitle('Task', { description: 'Explore repo' })).toBe('Explore repo');
    expect(toolCallTitle('Task', {})).toBe('Task');
    expect(toolCallTitle('WebFetch', { url: 'https://x.y' })).toBe('Fetch https://x.y');
    expect(toolCallTitle('WebSearch', { query: 'devin' })).toBe('Search devin');
    expect(toolCallTitle('TodoWrite', { todos: [] })).toBe('Update todos');
    expect(toolCallTitle('mcp__foo__bar', { a: 1 })).toBe('mcp__foo__bar');
  });

  it('kinds per tool', () => {
    expect(toolCallKind('Read')).toBe('read');
    expect(toolCallKind('LS')).toBe('read');
    expect(toolCallKind('Grep')).toBe('search');
    expect(toolCallKind('Glob')).toBe('search');
    for (const name of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) expect(toolCallKind(name)).toBe('edit');
    expect(toolCallKind('Bash')).toBe('execute');
    expect(toolCallKind('WebFetch')).toBe('fetch');
    expect(toolCallKind('WebSearch')).toBe('fetch');
    expect(toolCallKind('Task')).toBe('think');
    expect(toolCallKind('Whatever')).toBe('other');
  });

  it('locations only for file tools', () => {
    expect(toolCallLocations('Read', { file_path: '/a/b.ts' })).toEqual([{ path: '/a/b.ts' }]);
    expect(toolCallLocations('NotebookEdit', { notebook_path: 'n.ipynb' })).toEqual([{ path: 'n.ipynb' }]);
    expect(toolCallLocations('Edit', {})).toBeUndefined();
    expect(toolCallLocations('Bash', { command: 'ls' })).toBeUndefined();
  });
});

describe('translateSdkMessage', () => {
  it('system/init → init with nulls for missing fields; never session_info_update', () => {
    const full = translateSdkMessage(
      { type: 'system', subtype: 'init', session_id: SID, model: 'claude-x', permissionMode: 'plan', cwd: '/w' },
      LIVE,
    );
    expect(full).toEqual({ updates: [], init: { model: 'claude-x', permissionMode: 'plan', cwd: '/w' } });
    expect(translateSdkMessage({ type: 'system', subtype: 'init' }, HIST).init).toEqual({
      model: null,
      permissionMode: null,
      cwd: null,
    });
  });

  it('stream text/thinking deltas → chunks without messageId when streaming', () => {
    expect(translateSdkMessage(delta({ type: 'text_delta', text: 'Hel' }), LIVE).updates).toEqual([
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hel' } },
    ]);
    expect(translateSdkMessage(delta({ type: 'thinking_delta', thinking: 'hmm' }), LIVE).updates).toEqual([
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } },
    ]);
  });

  it('stream deltas carry opts.messageId when the host supplies one; empty/null → none', () => {
    const withId = { streaming: true, messageId: 'msg_a' };
    expect(translateSdkMessage(delta({ type: 'text_delta', text: 'Hel' }), withId).updates).toEqual([
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hel' }, messageId: 'msg_a' },
    ]);
    expect(translateSdkMessage(delta({ type: 'thinking_delta', thinking: 'hmm' }), withId).updates).toEqual([
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' }, messageId: 'msg_a' },
    ]);
    for (const opts of [{ streaming: true, messageId: null }, { streaming: true, messageId: '' }, LIVE]) {
      expect(translateSdkMessage(delta({ type: 'text_delta', text: 'x' }), opts).updates).toEqual([
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } },
      ]);
    }
    expect(translateSdkMessage(delta({ type: 'text_delta', text: 'x' }), { streaming: false, messageId: 'msg_a' }).updates).toEqual([]);
  });

  it('messageIdFromStreamEvent reads message_start ids and nothing else', () => {
    const start = (message: unknown) => ({ type: 'stream_event', session_id: SID, event: { type: 'message_start', message } });
    expect(messageIdFromStreamEvent(start({ id: 'msg_01', role: 'assistant' }))).toBe('msg_01');
    const nulls: unknown[] = [
      start({ id: '' }),
      start({ id: 7 }),
      start({}),
      start(null),
      start('msg_01'),
      { type: 'stream_event', event: { type: 'message_stop' } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } } },
      { type: 'stream_event', event: { type: 'message_start' } },
      { type: 'stream_event', event: null },
      { type: 'stream_event' },
      { type: 'assistant', event: { type: 'message_start', message: { id: 'msg_01' } } },
      null,
      undefined,
      42,
      'str',
      [],
      {},
    ];
    for (const input of nulls) expect(messageIdFromStreamEvent(input)).toBeNull();
  });

  it('stream deltas are ignored when not streaming, from subagents, or of other kinds', () => {
    expect(translateSdkMessage(delta({ type: 'text_delta', text: 'x' }), HIST).updates).toEqual([]);
    expect(translateSdkMessage(delta({ type: 'text_delta', text: 'x' }, 'parent'), LIVE).updates).toEqual([]);
    expect(translateSdkMessage(delta({ type: 'input_json_delta', partial_json: '{' }), LIVE).updates).toEqual([]);
    expect(translateSdkMessage(delta({ type: 'signature_delta', signature: 'z' }), LIVE).updates).toEqual([]);
    for (const type of ['message_start', 'message_stop', 'content_block_start', 'content_block_stop', 'ping']) {
      const msg = { type: 'stream_event', uuid: 'e', session_id: SID, parent_tool_use_id: null, event: { type } };
      expect(translateSdkMessage(msg, LIVE).updates).toEqual([]);
    }
  });

  it('assistant tool_use → tool_call in both modes; text/thinking only when not streaming', () => {
    const content = [
      { type: 'thinking', thinking: 'plan', signature: 's' },
      { type: 'text', text: 'Running' },
      { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls -la' } },
      { type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: '/r/x.ts' } },
    ];
    const toolCalls = [
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'tu1',
        title: 'ls -la',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: 'ls -la' },
      },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'tu2',
        title: 'Read x.ts',
        kind: 'read',
        status: 'in_progress',
        rawInput: { file_path: '/r/x.ts' },
        locations: [{ path: '/r/x.ts' }],
      },
    ];
    expect(translateSdkMessage(assistant(content), LIVE).updates).toEqual(toolCalls);
    expect(translateSdkMessage(assistant(content), HIST).updates).toEqual([
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'plan' }, messageId: 'a-1' },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Running' }, messageId: 'a-1' },
      ...toolCalls,
    ]);
  });

  it('assistant string content is one text block; message.id is the messageId fallback', () => {
    const msg = { ...assistant('plain'), uuid: undefined };
    expect(translateSdkMessage(msg, HIST).updates).toEqual([
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'plain' }, messageId: 'msg_1' },
    ]);
    expect(translateSdkMessage(msg, LIVE).updates).toEqual([]);
  });

  it('subagent assistant tool_use folds into the parent tool call; text is dropped', () => {
    const content = [
      { type: 'text', text: 'sub text' },
      { type: 'tool_use', id: 'sub1', name: 'Grep', input: { pattern: 'TODO' } },
      { type: 'tool_use', id: 'sub2', name: 'Bash', input: { command: 'npm test' } },
    ];
    const expected = [
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'task1',
        appendContent: true,
        content: [{ type: 'content', content: { type: 'text', text: '↳ Grep TODO' } }],
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'task1',
        appendContent: true,
        content: [{ type: 'content', content: { type: 'text', text: '↳ npm test' } }],
      },
    ];
    expect(translateSdkMessage(assistant(content, 'task1'), LIVE).updates).toEqual(expected);
    expect(translateSdkMessage(assistant(content, 'task1'), HIST).updates).toEqual(expected);
  });

  it('user tool_result → tool_call_update with status, rawOutput and truncated text', () => {
    const long = 'y'.repeat(TOOL_RESULT_TEXT_MAX + 50);
    const msg = user([
      { type: 'tool_result', tool_use_id: 'tu1', content: 'ok\nline2', is_error: false },
      { type: 'tool_result', tool_use_id: 'tu2', content: [{ type: 'text', text: 'a' }, { type: 'text', text: long }], is_error: true },
      { type: 'tool_result', tool_use_id: 'tu3', content: [{ type: 'image', source: {} }] },
    ]);
    const updates = translateSdkMessage(msg, LIVE).updates;
    expect(updates).toHaveLength(3);
    expect(updates[0]).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tu1',
      appendContent: true,
      status: 'completed',
      rawOutput: 'ok\nline2',
      content: [{ type: 'content', content: { type: 'text', text: 'ok\nline2' } }],
    });
    const second = updates[1] as { status: string; content: Array<{ content: { text: string } }> };
    expect(second.status).toBe('failed');
    expect(second.content[0]!.content.text).toHaveLength(TOOL_RESULT_TEXT_MAX);
    expect(second.content[0]!.content.text.startsWith('a\nyyy')).toBe(true);
    expect(second.content[0]!.content.text.endsWith('…')).toBe(true);
    expect(updates[2]).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tu3',
      appendContent: true,
      status: 'completed',
      rawOutput: [{ type: 'image', source: {} }],
    });
    expect(translateSdkMessage(msg, HIST).updates).toEqual(updates);
  });

  it('plain user text → user_message_chunk only in history mode and not for synthetic/meta', () => {
    expect(translateSdkMessage(user('hello'), HIST).updates).toEqual([
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hello' }, messageId: 'u-1' },
    ]);
    expect(translateSdkMessage(user([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), HIST).updates).toEqual([
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'a' }, messageId: 'u-1' },
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'b' }, messageId: 'u-1' },
    ]);
    expect(translateSdkMessage(user('hello'), LIVE).updates).toEqual([]);
    expect(translateSdkMessage(user('hello', { isSynthetic: true }), HIST).updates).toEqual([]);
    expect(translateSdkMessage(user('hello', { isMeta: true }), HIST).updates).toEqual([]);
  });

  it('subagent user messages are skipped entirely', () => {
    const msg = user([{ type: 'tool_result', tool_use_id: 'sub1', content: 'x' }], { parent_tool_use_id: 'task1' });
    expect(translateSdkMessage(msg, LIVE)).toEqual({ updates: [] });
    expect(translateSdkMessage(msg, HIST)).toEqual({ updates: [] });
  });

  it('result success → finish end_turn with usage mapping and usage_update from modelUsage', () => {
    const out = translateSdkMessage(
      {
        type: 'result',
        subtype: 'success',
        duration_ms: 10,
        is_error: false,
        usage: USAGE,
        modelUsage: {
          'claude-a': { contextWindow: 200000, inputTokens: 1 },
          'claude-b': { contextWindow: 1000000 },
        },
        result: 'done',
      },
      LIVE,
    );
    expect(out.finish).toEqual({
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 100, cachedWriteTokens: 20, totalTokens: 15 },
    });
    expect(out.updates).toEqual([{ sessionUpdate: 'usage_update', used: 130, size: 1000000 }]);
  });

  it('result without modelUsage or context window emits no usage_update; partial usage keeps nulls', () => {
    const out = translateSdkMessage(
      { type: 'result', subtype: 'success', usage: { input_tokens: 3 }, modelUsage: { m: { contextWindow: 0 } } },
      LIVE,
    );
    expect(out.updates).toEqual([]);
    expect(out.finish?.usage).toEqual({
      inputTokens: 3,
      outputTokens: null,
      cachedReadTokens: null,
      cachedWriteTokens: null,
      totalTokens: null,
    });
    expect(translateSdkMessage({ type: 'result', subtype: 'success' }, LIVE).finish?.stopReason).toBe('end_turn');
  });

  it('result total_cost_usd → finish.usage.costUsd, with or without a usage object; non-finite ignored', () => {
    const withUsage = translateSdkMessage(
      { type: 'result', subtype: 'success', usage: USAGE, total_cost_usd: 0.1234 },
      LIVE,
    );
    expect(withUsage.finish?.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cachedReadTokens: 100,
      cachedWriteTokens: 20,
      totalTokens: 15,
      costUsd: 0.1234,
    });
    const noUsage = translateSdkMessage({ type: 'result', subtype: 'error_max_turns', total_cost_usd: 0.5 }, LIVE);
    expect(noUsage.finish).toEqual({
      stopReason: 'max_turn_requests',
      usage: {
        inputTokens: null,
        outputTokens: null,
        cachedReadTokens: null,
        cachedWriteTokens: null,
        totalTokens: null,
        costUsd: 0.5,
      },
    });
    expect(translateSdkMessage({ type: 'result', subtype: 'success', total_cost_usd: 0 }, LIVE).finish?.usage?.costUsd).toBe(0);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '0.1', null, undefined]) {
      const out = translateSdkMessage({ type: 'result', subtype: 'success', usage: USAGE, total_cost_usd: bad }, LIVE);
      expect(out.finish?.usage).not.toHaveProperty('costUsd');
    }
  });

  it('result error subtypes', () => {
    expect(translateSdkMessage({ type: 'result', subtype: 'error_max_turns', usage: USAGE }, LIVE).finish).toMatchObject({
      stopReason: 'max_turn_requests',
    });
    const noisy = `\x1b[31mBoom\x1b[0m   went\n\nwrong ${'z'.repeat(600)}`;
    const during = translateSdkMessage(
      { type: 'result', subtype: 'error_during_execution', errors: [noisy, 'second'], result: 'ignored' },
      LIVE,
    ).finish!;
    expect(during.stopReason).toBe('error');
    expect(during.error!.startsWith('Boom went wrong zzz')).toBe(true);
    expect(during.error).toHaveLength(ERROR_TEXT_MAX);
    expect(during.error!.endsWith('…')).toBe(true);
    expect(
      translateSdkMessage({ type: 'result', subtype: 'error_during_execution', result: 'from result' }, LIVE).finish,
    ).toMatchObject({ stopReason: 'error', error: 'from result' });
    expect(translateSdkMessage({ type: 'result', subtype: 'error_during_execution' }, LIVE).finish).toMatchObject({
      stopReason: 'error',
      error: 'error_during_execution',
    });
    expect(translateSdkMessage({ type: 'result', subtype: 'error_max_budget_usd' }, LIVE).finish).toMatchObject({
      stopReason: 'error',
      error: 'error_max_budget_usd',
    });
  });

  it('compact_boundary → its own agent message', () => {
    expect(translateSdkMessage({ type: 'system', subtype: 'compact_boundary', uuid: 'c1' }, LIVE).updates).toEqual([
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '_Context compacted_' }, messageId: 'compact-c1' },
    ]);
  });

  it('unknown and malformed input → no updates, never throws', () => {
    const cases: unknown[] = [
      null,
      undefined,
      42,
      'str',
      [],
      {},
      { type: 'status' },
      { type: 'tool_progress' },
      { type: 'system', subtype: 'hook_started' },
      { type: 'rate_limit_event' },
      { type: 'assistant' },
      { type: 'assistant', message: { content: [null, 1, { type: 'tool_use' }] } },
      { type: 'user', message: {} },
      { type: 'user', message: { content: [{ type: 'tool_result' }] } },
      { type: 'stream_event', parent_tool_use_id: null },
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta' } },
      { type: 'result' },
      { type: 'result', subtype: 'success', usage: 'nope', modelUsage: 'nope' },
    ];
    for (const input of cases) {
      const out = translateSdkMessage(input, LIVE);
      expect(out.updates).toEqual([]);
      expect(translateSdkMessage(input, HIST).updates).toEqual([]);
    }
  });
});

describe('round trip through the reducers', () => {
  it('parent Task call: two subagent folds then a tool_result keep all content in order', () => {
    type S = ChatStateLike & { sessions: Record<string, ReturnType<typeof newChatSession>> };
    let state: S = { sessions: { [SID]: { ...newChatSession({ id: SID }) } } };
    state = startPrompt(state, SID, 'hi', '2026-10-01T00:00:00Z');
    state = applyUpdate(state, SID, {
      sessionUpdate: 'tool_call',
      toolCallId: 'task1',
      title: 'Task',
      status: 'in_progress',
    });
    const messages: unknown[] = [
      assistant([{ type: 'tool_use', id: 'sub1', name: 'Grep', input: { pattern: 'a' } }], 'task1', 'a-1'),
      assistant([{ type: 'tool_use', id: 'sub2', name: 'Bash', input: { command: 'go' } }], 'task1', 'a-2'),
      user([{ type: 'tool_result', tool_use_id: 'task1', content: 'done', is_error: false }]),
    ];
    for (const msg of messages) {
      for (const update of translateSdkMessage(msg, LIVE).updates) {
        state = applyUpdate(state, SID, update);
      }
    }
    expect(state.sessions[SID]!.toolCalls.task1).toEqual({
      id: 'task1',
      title: 'Task',
      status: 'completed',
      rawOutput: 'done',
      content: [
        { type: 'content', content: { type: 'text', text: '↳ Grep a' } },
        { type: 'content', content: { type: 'text', text: '↳ go' } },
        { type: 'content', content: { type: 'text', text: 'done' } },
      ],
    });
  });

  it('live turn: init, deltas, tool_use, tool_result, result', () => {
    type S = ChatStateLike & { sessions: Record<string, ReturnType<typeof newChatSession> & { cwd: string }> };
    let state: S = { sessions: { [SID]: { ...newChatSession({ id: SID }), cwd: '/w' } } };
    state = startPrompt(state, SID, 'list files', '2026-10-01T00:00:00Z');
    const start = (id: string) => ({
      type: 'stream_event',
      uuid: 'ev-0',
      session_id: SID,
      parent_tool_use_id: null,
      event: { type: 'message_start', message: { id, role: 'assistant', content: [] } },
    });
    const script: unknown[] = [
      { type: 'system', subtype: 'init', model: 'claude-x', permissionMode: 'default', cwd: '/w' },
      start('msg_1'),
      delta({ type: 'thinking_delta', thinking: 'Let me ' }),
      delta({ type: 'thinking_delta', thinking: 'look.' }),
      delta({ type: 'text_delta', text: 'Listing' }),
      delta({ type: 'text_delta', text: ' now.' }),
      assistant([
        { type: 'thinking', thinking: 'Let me look.' },
        { type: 'text', text: 'Listing now.' },
        { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } },
      ]),
      user([{ type: 'tool_result', tool_use_id: 'tu1', content: 'a.ts\nb.ts', is_error: false }]),
      assistant([{ type: 'tool_use', id: 'sub1', name: 'Read', input: { file_path: 'a.ts' } }], 'tu1'),
      start('msg_2'),
      delta({ type: 'text_delta', text: 'Done.' }),
      {
        type: 'result',
        subtype: 'success',
        usage: USAGE,
        total_cost_usd: 0.0421,
        modelUsage: { 'claude-x': { contextWindow: 200000 } },
      },
    ];
    let init: unknown;
    let messageId: string | null = null;
    for (const msg of script) {
      messageId = messageIdFromStreamEvent(msg) ?? messageId;
      const out = translateSdkMessage(msg, { streaming: true, messageId });
      if (out.init) init = out.init;
      for (const update of out.updates) state = applyUpdate(state, SID, update);
      if (out.finish) {
        state = finishPrompt(state, SID, out.finish.stopReason, {
          now: '2026-10-01T00:00:03Z',
          usage: out.finish.usage,
          ...(out.finish.error ? { error: out.finish.error } : {}),
        });
      }
    }
    const session = state.sessions[SID]!;
    expect(init).toEqual({ model: 'claude-x', permissionMode: 'default', cwd: '/w' });
    expect(session.cwd).toBe('/w');
    expect(session.running).toBe(false);
    expect(session.lastStopReason).toBe('end_turn');
    expect(session.lastTurnMs).toBe(3000);
    expect(session.title).toBe('list files');
    expect(session.messages).toEqual([
      { role: 'user', blocks: [{ type: 'text', text: 'list files' }] },
      {
        role: 'agent',
        messageId: 'msg_1',
        blocks: [
          { type: 'thought', text: 'Let me look.' },
          { type: 'text', text: 'Listing now.' },
          { type: 'tool_call', id: 'tu1' },
        ],
      },
      { role: 'agent', messageId: 'msg_2', blocks: [{ type: 'text', text: 'Done.' }] },
    ]);
    expect(session.toolCalls.tu1).toEqual({
      id: 'tu1',
      title: 'ls',
      kind: 'execute',
      status: 'completed',
      rawInput: { command: 'ls' },
      rawOutput: 'a.ts\nb.ts',
      // appendContent keeps arrival order: the tool_result text landed
      // before the subagent fold (replace semantics used to drop it).
      content: [
        { type: 'content', content: { type: 'text', text: 'a.ts\nb.ts' } },
        { type: 'content', content: { type: 'text', text: '↳ Read a.ts' } },
      ],
    });
    expect(session.usage).toMatchObject({
      used: 130,
      size: 200000,
      inputTokens: 10,
      outputTokens: 5,
      cachedReadTokens: 100,
      cachedWriteTokens: 20,
      totalTokens: 15,
      costUsd: 0.0421,
    });
  });

  it('history replay: user text, assistant text + tool_use, tool_result', () => {
    let state: ChatStateLike = { sessions: { [SID]: newChatSession({ id: SID, loaded: false }) } };
    const script: unknown[] = [
      { ...user('Fix the bug'), uuid: 'u-1' },
      assistant([{ type: 'text', text: 'On it.' }, { type: 'tool_use', id: 'tu1', name: 'Edit', input: { file_path: 'x.ts' } }], null, 'a-1'),
      { ...user([{ type: 'tool_result', tool_use_id: 'tu1', content: 'edited' }]), uuid: 'u-2' },
      assistant([{ type: 'text', text: 'Fixed.' }], null, 'a-2'),
      { ...user('Thanks'), uuid: 'u-3' },
    ];
    for (const msg of script) {
      for (const update of translateSdkMessage(msg, HIST).updates) state = applyUpdate(state, SID, update);
    }
    const session = state.sessions[SID]!;
    expect(session.title).toBe('Fix the bug');
    expect(session.messages).toEqual([
      { role: 'user', blocks: [{ type: 'text', text: 'Fix the bug' }], messageId: 'u-1' },
      { role: 'agent', blocks: [{ type: 'text', text: 'On it.' }, { type: 'tool_call', id: 'tu1' }], messageId: 'a-1' },
      { role: 'agent', blocks: [{ type: 'text', text: 'Fixed.' }], messageId: 'a-2' },
      { role: 'user', blocks: [{ type: 'text', text: 'Thanks' }], messageId: 'u-3' },
    ]);
    expect(session.toolCalls.tu1).toMatchObject({ status: 'completed', locations: [{ path: 'x.ts' }] });
  });
});
