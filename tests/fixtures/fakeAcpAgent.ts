// Fake ACP v1 agent speaking newline-delimited JSON-RPC over stdio.
// Built to out/fixtures/fakeAcpAgent.cjs and selected by the app in test mode via
//   AGENT_WORKSPACE_TEST=1 AGENT_WORKSPACE_LOCAL_AGENT_CMD="node out/fixtures/fakeAcpAgent.cjs"
// Capabilities: FAKE_ACP_LIST=1 advertises session/list, FAKE_ACP_LOAD=1 advertises
// session/load, FAKE_ACP_DELETE=1 advertises sessionCapabilities.delete +
// session/delete. FAKE_ACP_LINK_URL is embedded as a markdown link in every reply.
import { appendFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import {
  AgentSideConnection,
  ndJsonStream,
  type Agent,
  type SessionNotification,
} from '@agentclientprotocol/sdk';

const supportsList = process.env.FAKE_ACP_LIST === '1';
const supportsLoad = process.env.FAKE_ACP_LOAD === '1';
const supportsDelete = process.env.FAKE_ACP_DELETE === '1';
const linkUrl = process.env.FAKE_ACP_LINK_URL ?? 'https://github.com/cognition-ai/agent-workspace/pull/1';
// FAKE_ACP_USAGE=1 emits a usage_update mid-prompt and a `usage` field on the
// prompt response; FAKE_ACP_PROMPT_DELAY_MS stalls mid-prompt so the UI's
// thinking indicator is observable.
const emitUsage = process.env.FAKE_ACP_USAGE === '1';
const promptDelayMs = Number(process.env.FAKE_ACP_PROMPT_DELAY_MS ?? 0) || 0;
// FAKE_ACP_MODES=1 makes newSession/loadSession advertise the devin-mode list
// and enables session/set_mode; FAKE_ACP_MODE_LOG appends `<sessionId> <modeId>`
// lines so specs can assert which mode the app selected.
const supportsModes = process.env.FAKE_ACP_MODES === '1';
const modeLogFile = process.env.FAKE_ACP_MODE_LOG || null;

const USAGE = { totalTokens: 1234, inputTokens: 1000, outputTokens: 234 };

const AVAILABLE_MODES = [
  { id: 'accept-edits', name: 'Code' },
  { id: 'smart', name: 'Smart' },
  { id: 'ask', name: 'Ask' },
  { id: 'plan', name: 'Plan' },
  { id: 'bypass', name: 'Bypass Permissions' },
];

type Session = {
  id: string;
  cwd: string;
  title: string;
  createdAt: string;
  history: SessionNotification['update'][];
  cancelled: boolean;
  modeId: string;
};

const sessions = new Map<string, Session>();
let counter = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

process.stderr.write(`fake-acp-agent pid=${process.pid} list=${supportsList} load=${supportsLoad}\n`);

const stream = ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);

function createAgent(connection: AgentSideConnection): Agent {
  const emit = async (session: Session, update: SessionNotification['update']) => {
    session.history.push(update);
    await connection.sessionUpdate({ sessionId: session.id, update });
  };

  const agent: Agent = {
    async initialize(params) {
      return {
        protocolVersion: params.protocolVersion,
        agentCapabilities: {
          loadSession: supportsLoad,
          ...(supportsList || supportsDelete
            ? {
                sessionCapabilities: {
                  ...(supportsList ? { list: {} } : {}),
                  ...(supportsDelete ? { delete: {} } : {}),
                },
              }
            : {}),
        },
        agentInfo: { name: 'fake-acp', title: 'Fake ACP Agent', version: '0.0.1' },
      };
    },
    async authenticate() {
      return {};
    },
    async newSession(params) {
      counter += 1;
      const id = `fake-${process.pid}-${counter}`;
      sessions.set(id, {
        id,
        cwd: params.cwd,
        title: '',
        createdAt: new Date().toISOString(),
        history: [],
        cancelled: false,
        modeId: 'accept-edits',
      });
      if (!supportsModes) return { sessionId: id };
      return {
        sessionId: id,
        modes: {
          currentModeId: 'accept-edits',
          availableModes: AVAILABLE_MODES.map((mode) => ({ ...mode })),
        },
      };
    },
    async listSessions(params) {
      if (!supportsList) throw new Error('session/list not supported');
      const all = [...sessions.values()].filter((s) => !params.cwd || s.cwd === params.cwd);
      return {
        sessions: all.map((s) => ({
          sessionId: s.id,
          cwd: s.cwd,
          title: s.title || null,
          updatedAt: s.createdAt,
          _meta: { 'cognition.ai/createdAt': s.createdAt },
        })),
      };
    },
    async loadSession(params) {
      if (!supportsLoad) throw new Error('session/load not supported');
      let session = sessions.get(params.sessionId);
      if (!session) {
        // After a restart we know nothing about older sessions; accept and replay nothing.
        session = {
          id: params.sessionId,
          cwd: params.cwd,
          title: '',
          createdAt: new Date().toISOString(),
          history: [],
          cancelled: false,
          modeId: 'accept-edits',
        };
        sessions.set(session.id, session);
      }
      for (const update of session.history) {
        await connection.sessionUpdate({ sessionId: session.id, update });
      }
      if (!supportsModes) return {};
      return {
        modes: {
          currentModeId: session.modeId,
          availableModes: AVAILABLE_MODES.map((mode) => ({ ...mode })),
        },
      };
    },
    async setSessionMode(params) {
      if (!supportsModes) throw new Error('session/set_mode not supported');
      const session = sessions.get(params.sessionId);
      if (!session) throw new Error(`unknown session ${params.sessionId}`);
      if (!AVAILABLE_MODES.some((mode) => mode.id === params.modeId)) {
        throw new Error(`unknown mode ${params.modeId}`);
      }
      if (modeLogFile) appendFileSync(modeLogFile, `${params.sessionId} ${params.modeId}\n`);
      session.modeId = params.modeId;
      await connection.sessionUpdate({
        sessionId: session.id,
        update: {
          sessionUpdate: 'current_mode_update',
          currentModeId: params.modeId,
        } as SessionNotification['update'],
      });
      return {};
    },
    async deleteSession(params) {
      if (!supportsDelete) throw new Error('session/delete not supported');
      // Idempotent: after a restart we know nothing about older sessions, but
      // the real CLI persists them — deleting one we forgot still succeeds.
      sessions.delete(params.sessionId);
      return {};
    },
    async cancel(params) {
      const session = sessions.get(params.sessionId);
      if (session) session.cancelled = true;
    },
    async prompt(params) {
      const session = sessions.get(params.sessionId);
      if (!session) throw new Error(`unknown session ${params.sessionId}`);
      session.cancelled = false;
      const text = params.prompt
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
      if (!session.title) session.title = text.slice(0, 60);
      await emit(session, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } });

      if (/slow/i.test(text)) {
        await emit(session, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Counting slowly: ' },
        });
        for (let index = 1; index <= 20; index += 1) {
          if (session.cancelled) return { stopReason: 'cancelled' };
          await emit(session, {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `${index} ` },
          });
          await sleep(250);
        }
        return { stopReason: session.cancelled ? 'cancelled' : 'end_turn' };
      }

      await emit(session, {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'The user said something. ' },
      });
      if (emitUsage) {
        await emit(session, {
          sessionUpdate: 'usage_update',
          used: 1234,
          size: 200000,
          _meta: {
            'cognition.ai/inputTokens': 1000,
            'cognition.ai/outputTokens': 234,
          },
        } as unknown as SessionNotification['update']);
      }
      if (promptDelayMs > 0) await sleep(promptDelayMs);
      await sleep(10);
      await emit(session, {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'I should reply politely.' },
      });

      if (/permission/i.test(text)) {
        await emit(session, {
          sessionUpdate: 'tool_call',
          toolCallId: 'perm-1',
          title: 'Run `npm test`',
          kind: 'execute',
          status: 'pending',
          rawInput: { command: 'npm test' },
        });
        const response = await connection.requestPermission({
          sessionId: session.id,
          toolCall: { toolCallId: 'perm-1', title: 'Run `npm test`', kind: 'execute', status: 'pending' },
          options: [
            { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
          ],
        });
        if (response.outcome.outcome === 'cancelled') {
          await emit(session, { sessionUpdate: 'tool_call_update', toolCallId: 'perm-1', status: 'failed' });
          return { stopReason: 'cancelled' };
        }
        if (response.outcome.optionId !== 'allow') {
          await emit(session, { sessionUpdate: 'tool_call_update', toolCallId: 'perm-1', status: 'failed' });
          await emit(session, {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Permission denied; aborting.' },
          });
          return { stopReason: 'end_turn' };
        }
        await emit(session, {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'perm-1',
          status: 'completed',
          rawOutput: 'all tests passed',
        });
        await emit(session, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Permission granted, tests passed. ' },
        });
      }

      await emit(session, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } });
      await sleep(10);
      await emit(session, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'from the ' } });
      await sleep(10);
      await emit(session, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `fake agent. See [the pull request](${linkUrl}).` },
      });
      await emit(session, {
        sessionUpdate: 'tool_call',
        toolCallId: `tc-${session.history.length}`,
        title: 'Read README.md',
        kind: 'read',
        status: 'in_progress',
        locations: [{ path: 'README.md', line: 1 }],
        rawInput: { path: 'README.md' },
      });
      await sleep(10);
      const lastToolCall = [...session.history].reverse().find((u) => u.sessionUpdate === 'tool_call');
      const toolCallId = lastToolCall && 'toolCallId' in lastToolCall ? lastToolCall.toolCallId : 'tc';
      await emit(session, {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: '# README' } }],
        rawOutput: '# README',
      });
      await emit(session, {
        sessionUpdate: 'plan',
        entries: [
          { content: 'Read the repository', priority: 'high', status: 'completed' },
          { content: 'Reply to the user', priority: 'medium', status: 'in_progress' },
          { content: 'Celebrate', priority: 'low', status: 'pending' },
        ],
      });
      return { stopReason: 'end_turn', ...(emitUsage ? { usage: USAGE } : {}) };
    },
  };
  return agent;
}

new AgentSideConnection(createAgent, stream);

process.stdin.on('end', () => process.exit(0));
