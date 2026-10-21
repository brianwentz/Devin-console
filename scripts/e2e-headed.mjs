// Headed e2e: quiet mode is on by default in test mode; run with it off so
// the window is visible for debugging.
import { spawnSync } from 'node:child_process';

const result = spawnSync('npm', ['run', 'test:e2e', '--', ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, AGENT_WORKSPACE_TEST_QUIET: '0' },
});
process.exit(result.status ?? 1);
