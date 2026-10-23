// Playwright globalSetup / Vitest globalSetup: give the whole run one temp root
// and delete it when the run ends (see tempRoot.ts). Workers and the Electron
// apps the specs launch inherit the environment set here, so every os.tmpdir()
// / mkdtemp call lands inside the run root.

import { tmpdir } from 'node:os';
import { createRunRoot, removeDir, sweepStaleRunRoots } from './tempRoot';

export default function globalTemp(): () => void {
  const realBase = tmpdir();
  sweepStaleRunRoots(realBase);
  const root = createRunRoot(realBase);
  process.env.TEMP = root;
  process.env.TMP = root;
  process.env.TMPDIR = root;
  return () => {
    if (!removeDir(root)) console.warn(`[tests] could not fully remove the run temp root: ${root}`);
  };
}
