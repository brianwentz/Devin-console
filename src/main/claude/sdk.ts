import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { log } from '../log';

// Single memoised dynamic import of the ESM-only Agent SDK — it is packaged
// external + unpacked, so Node's resolver (not esbuild) resolves it at
// runtime. The version is read from the package.json via createRequire so the
// log stays dependency-only; the module path is never logged.
let pending: Promise<typeof import('@anthropic-ai/claude-agent-sdk')> | null = null;

export function loadSdk(): Promise<typeof import('@anthropic-ai/claude-agent-sdk')> {
  if (!pending) {
    const t0 = Date.now();
    pending = import('@anthropic-ai/claude-agent-sdk')
      .then((sdk) => {
        let version: string | null = null;
        try {
          // The exports map blocks './package.json' — resolve the entry point
          // and read the sibling manifest by path instead.
          const require = createRequire(__filename);
          const entry = require.resolve('@anthropic-ai/claude-agent-sdk');
          const pkg = JSON.parse(
            readFileSync(join(entry, '..', 'package.json'), 'utf8'),
          ) as { version?: string };
          version = pkg.version ?? null;
        } catch {
          version = null;
        }
        log('claude', 'claude-sdk-load', { detail: { ok: true, ms: Date.now() - t0, version } });
        return sdk;
      })
      .catch((error: unknown) => {
        // Leave pending rejected — a failed load stays sticky for the session.
        const message = error instanceof Error ? error.message : String(error);
        log('claude', 'claude-sdk-load', { detail: { ok: false, ms: Date.now() - t0, message } });
        throw error;
      });
  }
  return pending;
}
