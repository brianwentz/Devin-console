// Side-effect module imported second in index.ts (right after bootstrap):
// installs the remote-fs guard before the rest of the app loads.
import { log } from './log';
import { installRemoteFsGuard } from './remoteFsGuard';
import { testMode } from './state';

const uncRoot = testMode ? process.env.AGENT_WORKSPACE_TEST_WSL_UNC_ROOT?.trim() : undefined;

installRemoteFsGuard({
  throwOnViolation: testMode,
  extraPrefixes: uncRoot ? [uncRoot] : [],
  log: (op) => log('host', 'remote-fs-violation', { detail: { op } }),
});
