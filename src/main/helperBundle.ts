// Locates the in-distro helper bundle built by scripts/build.mjs into
// out/helper/. Until the build produces helper-hash.json the helper is
// "unavailable": no deploy, no probe token, no channel. No electron import so
// it stays unit-testable; callers pass the app's `out` directory.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseHelperHash } from '../core/execHost';

export interface HelperBundleInfo {
  hash: string;
  /** Absolute path of the bundle (inside the asar when packaged — Electron's fs reads it transparently). */
  file: string;
}

export const HELPER_BUNDLE_NAME = 'agent-workspace-helper.mjs';

export function loadHelperBundleInfo(outDir: string): HelperBundleInfo | null {
  let json: string;
  try {
    json = readFileSync(join(outDir, 'helper', 'helper-hash.json'), 'utf8');
  } catch {
    return null;
  }
  const hash = parseHelperHash(json);
  return hash ? { hash, file: join(outDir, 'helper', HELPER_BUNDLE_NAME) } : null;
}
