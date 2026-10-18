import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build as viteBuild } from 'vite';

await mkdir('out', { recursive: true });
await mkdir('out/scripts', { recursive: true });
await mkdir('out/fixtures', { recursive: true });

// Dependency preflight: fail fast when package.json is ahead of node_modules
// instead of surfacing a cryptic bundler "failed to resolve import" error.
await build({
  entryPoints: ['src/core/depPreflight.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: 'out/scripts/dep-preflight.cjs',
});
const { missingDependencies, formatMissingDependencies } = await import(
  pathToFileURL(resolve('out/scripts/dep-preflight.cjs')).href
);
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const missing = missingDependencies(pkg, (name) => existsSync(resolve('node_modules', name, 'package.json')));
if (missing.length > 0) {
  console.error(formatMissingDependencies(missing));
  process.exit(1);
}

await Promise.all([
  build({
    entryPoints: ['src/main/index.ts'],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    // node-pty is a native addon loaded from node_modules (asarUnpacked).
    external: ['electron', 'node-pty', '@anthropic-ai/claude-agent-sdk'],
    outfile: 'out/main.cjs',
    sourcemap: true,
  }),
  build({
    entryPoints: ['src/shell/preload.ts'],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['electron'],
    outfile: 'out/preload.cjs',
  }),
  build({
    entryPoints: ['src/autofill/preload.ts'],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['electron'],
    outfile: 'out/autofill-preload.cjs',
  }),
  build({
    entryPoints: ['scripts/os-input.ts'],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['electron', 'playwright'],
    outfile: 'out/scripts/os-input.cjs',
  }),
  // Fake ACP v1 agent used by the Local E2E tests (DEVIN_WORKSPACES_LOCAL_AGENT_CMD).
  build({
    entryPoints: ['tests/fixtures/fakeAcpAgent.ts'],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outfile: 'out/fixtures/fakeAcpAgent.cjs',
  }),
  // Echo pty used by the Terminal E2E (DEVIN_WORKSPACES_TEST_TERMINAL_CMD).
  build({
    entryPoints: ['tests/fixtures/fakePty.ts'],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outfile: 'out/fixtures/fakePty.cjs',
  }),
  // Fake `devin auth status` (DEVIN_WORKSPACES_TEST_AUTH_STATUS_CMD).
  build({
    entryPoints: ['tests/fixtures/fakeAuthStatus.ts'],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outfile: 'out/fixtures/fakeAuthStatus.cjs',
  }),
  build({
    entryPoints: ['scripts/measure-tabs.ts'],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['electron', 'playwright'],
    outfile: 'out/scripts/measure-tabs.cjs',
  }),
  // Claude SDK probes (plans/claude-sessions-phase-1.md). The Agent SDK is
  // ESM-only (createRequire(import.meta.url) fails when bundled to cjs), so
  // it stays external and the probes load it with a dynamic import().
  ...['claude-sdk-probe', 'claude-hooks-probe', 'claude-store-probe'].map((name) =>
    build({
      entryPoints: ['scripts/' + name + '.ts'],
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'cjs',
      external: ['electron', 'node-pty', '@anthropic-ai/claude-agent-sdk'],
      outfile: 'out/scripts/' + name + '.cjs',
    }),
  ),
  // Phase 2 fake SDK (DEVIN_WORKSPACES_TEST_CLAUDE_SDK): loaded by
  // dynamic import() → must be ESM with the real SDK external.
  build({
    entryPoints: ['tests/fixtures/fakeClaudeSdk.ts'],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    external: ['@anthropic-ai/claude-agent-sdk'],
    outfile: 'out/fixtures/fakeClaudeSdk.mjs',
  }),
  // Phase 3 fake `claude` CLI for background agents
  // (DEVIN_WORKSPACES_TEST_CLAUDE_AGENTS_CMD).
  build({
    entryPoints: ['tests/fixtures/fakeClaudeAgents.ts'],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outfile: 'out/fixtures/fakeClaudeAgents.cjs',
  }),
  // Phase 6 fake `gh` CLI for the PR-state fallback
  // (DEVIN_WORKSPACES_TEST_GH_CMD).
  build({
    entryPoints: ['tests/fixtures/fakeGh.ts'],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outfile: 'out/fixtures/fakeGh.cjs',
  }),
]);

await viteBuild({ configFile: 'vite.config.mts' });
