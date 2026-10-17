// Fake `claude` CLI for the background-agents e2e —
// DEVIN_WORKSPACES_TEST_CLAUDE_AGENTS_CMD=`node out/fixtures/fakeClaudeAgents.cjs`.
//   `agents --json --all` → prints the JSON file at FAKE_CLAUDE_AGENTS
//   `stop <id>`            → appends `stop <id>` to FAKE_CLAUDE_AGENTS_LOG
// Any other argv exits 0 silently.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);

if (args[0] === 'agents') {
  const file = process.env.FAKE_CLAUDE_AGENTS ?? '';
  process.stdout.write(existsSync(file) ? readFileSync(file, 'utf8') : '[]');
} else if (args[0] === 'stop' && args[1]) {
  const logFile = process.env.FAKE_CLAUDE_AGENTS_LOG ?? '';
  if (logFile) appendFileSync(logFile, `stop ${args[1]}\n`);
  process.stdout.write(`stopped ${args[1]}\n`);
}
