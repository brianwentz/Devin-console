// Builds the in-distro helper (src/helper/main.ts) into ONE ESM file plus
// helper-hash.json ({"hash": first 12 hex of sha256(bundle)}). ESM because the
// SDK's sdk.mjs calls createRequire(import.meta.url) at top level, which a cjs
// bundle turns into {}. Fails over the 3 MB budget.
// Used by scripts/build.mjs (→ out/helper) and tests/unit/helper/main.test.ts
// (`node scripts/build-helper.mjs <outDir>`).
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HELPER_BUNDLE_NAME = 'agent-workspace-helper.mjs';
export const HELPER_MAX_BYTES = 3 * 1024 * 1024;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** @returns {Promise<{ file: string, hash: string, bytes: number }>} */
export async function buildHelper(outDir) {
  await mkdir(outDir, { recursive: true });
  const file = join(outDir, HELPER_BUNDLE_NAME);
  await build({
    entryPoints: [join(root, 'src', 'helper', 'main.ts')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'esm',
    minify: true,
    legalComments: 'none',
    outfile: file,
    logLevel: 'error',
  });
  const bytes = await readFile(file);
  if (bytes.length >= HELPER_MAX_BYTES) {
    throw new Error(`helper bundle is ${bytes.length} bytes; the budget is < ${HELPER_MAX_BYTES}`);
  }
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  await writeFile(join(outDir, 'helper-hash.json'), JSON.stringify({ hash }));
  return { file, hash, bytes: bytes.length };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const outDir = resolve(process.argv[2] ?? join(root, 'out', 'helper'));
  try {
    const r = await buildHelper(outDir);
    console.log(`helper ${r.hash} ${(r.bytes / 1024).toFixed(0)} KB`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
