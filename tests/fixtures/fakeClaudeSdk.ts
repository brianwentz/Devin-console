// Fake Claude Agent SDK for the claudeChat e2e — loaded via
// DEVIN_WORKSPACES_TEST_CLAUDE_SDK → out/fixtures/fakeClaudeSdk.mjs.
// Re-exports the real store API (listSessions/getSessionMessages/…) and
// replaces `query` with a deterministic streaming-input generator that writes
// real-shaped jsonl lines into CLAUDE_CONFIG_DIR/projects/<encoded cwd>/ so
// the watcher/list/history all see real files.
//   FAKE_CLAUDE_TOOL=1         → the first turn asks for a Bash permission
//   FAKE_CLAUDE_DELAY_MS       → ms between the three text deltas (default 20)

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export * from '@anthropic-ai/claude-agent-sdk';

type Rec = Record<string, unknown>;

const state = ((globalThis as Rec).__fakeClaude ??= {
  permissionModes: [] as string[],
  models: [] as (string | null)[],
  interrupts: 0,
}) as { permissionModes: string[]; models: (string | null)[]; interrupts: number };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The SDK's project dir encoding (C:\work\alpha → C--work-alpha).
function encodeDir(cwd: string): string {
  return cwd.replace(/[:\\/]/g, '-');
}

function transcriptPath(configDir: string, cwd: string, sessionId: string): string {
  const dir = join(configDir, 'projects', encodeDir(cwd));
  mkdirSync(dir, { recursive: true });
  return join(dir, `${sessionId}.jsonl`);
}

function appendLine(path: string, entry: Rec): void {
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

const INTERRUPTED = 'Claude Code returned an error result: interrupted';

export function query({ prompt, options }: { prompt: unknown; options: Rec }) {
  const sessionId = String(options.resume ?? options.sessionId ?? randomUUID());
  const cwd = String(options.cwd ?? '');
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() ?? '';
  const delayMs = Number(process.env.FAKE_CLAUDE_DELAY_MS ?? 20) || 0;
  const file = configDir ? transcriptPath(configDir, cwd, sessionId) : null;

  let interrupted = false;
  let closed = false;

  async function* run() {
    yield {
      type: 'system',
      subtype: 'init',
      session_id: sessionId,
      model: 'fake-model',
      permissionMode: options.permissionMode ?? 'default',
      cwd,
    };
    for await (const userMsg of prompt as AsyncIterable<Rec>) {
      if (interrupted) throw new Error(INTERRUPTED);
      if (closed) return;
      const text =
        typeof userMsg.message === 'object' && userMsg.message !== null
          ? String((userMsg.message as Rec).content ?? '')
          : '';
      const ts = new Date().toISOString();
      const userUuid = randomUUID();
      if (file) {
        appendLine(file, {
          parentUuid: null,
          isSidechain: false,
          userType: 'external',
          cwd,
          sessionId,
          version: '2.1.296',
          gitBranch: 'main',
          type: 'user',
          message: { role: 'user', content: text },
          uuid: userUuid,
          timestamp: ts,
        });
      }

      const assistantBlocks: Rec[] = [];
      if (process.env.FAKE_CLAUDE_TOOL === '1') {
        const toolUseId = randomUUID();
        assistantBlocks.push({
          type: 'tool_use',
          id: toolUseId,
          name: 'Bash',
          input: { command: 'echo hi' },
        });
        // Like the real SDK: the assistant tool_use lands first (card shows
        // in_progress), then canUseTool parks until the user decides.
        yield {
          type: 'assistant',
          message: { role: 'assistant', content: assistantBlocks },
          uuid: randomUUID(),
          parent_tool_use_id: null,
          session_id: sessionId,
        };
        const signal = new AbortController().signal;
        const decision = await (
          options.canUseTool as (
            name: string,
            input: Rec,
            opts: Rec,
          ) => Promise<Rec | null>
        )('Bash', { command: 'echo hi' }, {
          signal,
          suggestions: [
            {
              type: 'addRules',
              rules: [{ toolName: 'Bash' }],
              behavior: 'allow',
              destination: 'session',
            },
          ],
          toolUseID: toolUseId,
        });
        if (interrupted) throw new Error(INTERRUPTED);
        const denied = !decision || decision.behavior !== 'allow';
        yield {
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: toolUseId,
                content: denied ? 'Permission denied' : 'hi\n',
                is_error: denied,
              },
            ],
          },
          uuid: randomUUID(),
          parent_tool_use_id: null,
          session_id: sessionId,
        };
      }

      const full = `Echo: ${text}`;
      const parts = [
        full.slice(0, Math.ceil(full.length / 3)),
        full.slice(Math.ceil(full.length / 3), Math.ceil((full.length * 2) / 3)),
        full.slice(Math.ceil((full.length * 2) / 3)),
      ];
      for (const part of parts) {
        await delay(delayMs);
        if (interrupted) throw new Error(INTERRUPTED);
        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: part },
          },
          session_id: sessionId,
        };
      }
      const assistantUuid = randomUUID();
      yield {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: full }, ...assistantBlocks],
        },
        uuid: assistantUuid,
        parent_tool_use_id: null,
        session_id: sessionId,
      };
      if (file) {
        appendLine(file, {
          parentUuid: userUuid,
          isSidechain: false,
          userType: 'external',
          cwd,
          sessionId,
          version: '2.1.296',
          gitBranch: 'main',
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: full }] },
          uuid: assistantUuid,
          timestamp: new Date().toISOString(),
        });
      }
      yield {
        type: 'result',
        subtype: 'success',
        uuid: randomUUID(),
        session_id: sessionId,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        modelUsage: { 'fake-model': { contextWindow: 200_000 } },
      };
    }
  }

  const it = run();
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next: (v?: unknown) => it.next(v),
    return: () => it.return(undefined),
    throw: (e?: unknown) => it.throw(e),
    interrupt: async () => {
      interrupted = true;
      state.interrupts += 1;
      return undefined;
    },
    setPermissionMode: async (mode: string) => {
      state.permissionModes.push(mode);
    },
    setModel: async (model: string | null) => {
      state.models.push(model);
    },
    close: () => {
      closed = true;
      void it.return(undefined);
    },
  };
}
