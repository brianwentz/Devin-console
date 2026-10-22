import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const SESSION_A = '11111111-0000-4000-8000-00000000000a';
export const SESSION_B = '11111111-0000-4000-8000-00000000000b';
export const SESSION_C = '11111111-0000-4000-8000-00000000000c';

/** Temp COPY of tests/fixtures/claude-home (the SDK writes into its config dir). */
export function copyClaudeHome(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'helper-claude-home-'));
  cpSync(resolve(__dirname, '../../fixtures/claude-home'), dir, { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) };
}

/** A chained user/assistant transcript for `sessionId` with `count` messages. */
export function transcriptLines(sessionId: string, count: number, cwd = '/home/u/work'): string {
  const lines: string[] = [];
  let parent: string | null = null;
  for (let i = 0; i < count; i++) {
    const uuid = `${sessionId}-m${i}`;
    const user = i % 2 === 0;
    lines.push(
      JSON.stringify({
        parentUuid: parent,
        isSidechain: false,
        userType: 'external',
        cwd,
        sessionId,
        version: '2.1.296',
        type: user ? 'user' : 'assistant',
        message: user
          ? { role: 'user', content: `prompt ${i}` }
          : { role: 'assistant', content: [{ type: 'text', text: `reply ${i}` }] },
        uuid,
        timestamp: new Date(Date.UTC(2026, 9, 10, 10, 0, i)).toISOString(),
      }),
    );
    parent = uuid;
  }
  return lines.join('\n') + '\n';
}
