// O6 memory measurement: launch the app against the fixture GitHub server, open 5 / 10 / 20
// tabs of the ~2 MB `/heavy` page, wait for every tab to finish loading, and sample
// `app.getAppMetrics()` (sum of workingSetSize over all Electron processes). Writes
// docs/evidence/p2-memory.json and docs/evidence/p2-memory.md.
//
// Build: `npm run build` (scripts/build.mjs bundles this to out/scripts/measure-tabs.cjs).
// Run:   `npm run measure:tabs`
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron, type ElectronApplication } from 'playwright';
import { startFixtureServers } from '../tests/fixtures/http';

type TabsState = {
  tabs: { activeId: string | null; tabs: Array<{ id: string; url: string; title: string; loading?: boolean }> };
};

interface Sample {
  tabs: number;
  totalWorkingSetMB: number;
  totalPrivateMB: number;
  processes: number;
  byType: Record<string, { count: number; workingSetMB: number }>;
  mainRssMB: number;
}

const DISCARD_THRESHOLD_MB = 2048;
const steps = [5, 10, 20];
const evidenceDir = resolve('docs/evidence');

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function poll(predicate: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function tabsState(app: ElectronApplication): Promise<TabsState> {
  return app.evaluate(() => (globalThis as typeof globalThis & { __agentworkspace: { state(): TabsState } }).__agentworkspace.state());
}

async function sample(app: ElectronApplication, tabs: number): Promise<Sample> {
  // Let renderers settle (layout, GC) before reading metrics.
  await delay(4000);
  const raw = await app.evaluate(({ app: electronApp }) => ({
    metrics: electronApp.getAppMetrics().map((m) => ({
      type: m.type,
      workingSetKB: m.memory.workingSetSize,
      privateKB: m.memory.privateBytes ?? 0,
    })),
    mainRss: process.memoryUsage().rss,
  }));
  const byType: Sample['byType'] = {};
  let totalWS = 0;
  let totalPrivate = 0;
  for (const m of raw.metrics) {
    totalWS += m.workingSetKB;
    totalPrivate += m.privateKB;
    const bucket = (byType[m.type] ??= { count: 0, workingSetMB: 0 });
    bucket.count += 1;
    bucket.workingSetMB += m.workingSetKB / 1024;
  }
  for (const bucket of Object.values(byType)) bucket.workingSetMB = Math.round(bucket.workingSetMB);
  return {
    tabs,
    totalWorkingSetMB: Math.round(totalWS / 1024),
    totalPrivateMB: Math.round(totalPrivate / 1024),
    processes: raw.metrics.length,
    byType,
    mainRssMB: Math.round(raw.mainRss / (1024 * 1024)),
  };
}

async function main(): Promise<void> {
  const fixtures = await startFixtureServers();
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-measure-'));
  mkdirSync(evidenceDir, { recursive: true });
  const logFile = join(evidenceDir, 'p2-memory-events.jsonl');
  writeFileSync(logFile, '', 'utf8');
  const app = await _electron.launch({
    args: [process.cwd()],
    timeout: 30_000,
    env: {
      ...process.env,
      AGENT_WORKSPACE_TEST: '1',
      AGENT_WORKSPACE_TENANT_URL: fixtures.devinUrl,
      AGENT_WORKSPACE_TEST_GITHUB_ORIGINS: fixtures.githubOrigins,
      AGENT_WORKSPACE_USER_DATA: profile,
      AGENT_WORKSPACE_LOG: logFile,
      AGENT_WORKSPACE_DOWNLOAD_DIR: join(profile, 'downloads'),
      AGENT_WORKSPACE_ALLOW_EXTERNAL: '0',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    },
  });
  const samples: Sample[] = [];
  try {
    await poll(() => app.evaluate(() => Boolean((globalThis as any).__agentworkspace)), 30_000, 'test hooks');
    await poll(
      () =>
        app.evaluate(({ webContents }, url: string) => webContents.getAllWebContents().some((c) => c.getURL().startsWith(url)), fixtures.devinUrl),
      30_000,
      'devin view',
    );
    samples.push(await sample(app, 0));
    console.log(`baseline: ${samples[0]!.totalWorkingSetMB} MB working set, ${samples[0]!.processes} processes`);

    let opened = 0;
    for (const target of steps) {
      while (opened < target) {
        opened += 1;
        const url = `${fixtures.githubUrl}/heavy/${opened}`;
        await app.evaluate((_e, u: string) => (globalThis as any).__agentworkspace.open(u), url);
      }
      await poll(async () => {
        const s = await tabsState(app);
        return s.tabs.tabs.length === target && s.tabs.tabs.every((t) => t.loading === false && t.title.includes('heavy'));
      }, 120_000, `${target} heavy tabs loaded`);
      const result = await sample(app, target);
      samples.push(result);
      console.log(
        `${target} tabs: ${result.totalWorkingSetMB} MB working set (${result.processes} processes; main ${result.mainRssMB} MB)`,
      );
    }
  } finally {
    await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
    await app.close().catch(() => undefined);
    await fixtures.close();
    await delay(500);
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch {
      // profile cleanup is best-effort
    }
  }

  const twenty = samples.find((s) => s.tabs === 20);
  const exceeds = Boolean(twenty && twenty.totalWorkingSetMB > DISCARD_THRESHOLD_MB);
  const perTab =
    twenty && samples[0] ? Math.round((twenty.totalWorkingSetMB - samples[0].totalWorkingSetMB) / 20) : null;
  const report = {
    generatedAt: new Date().toISOString(),
    platform: `${process.platform} ${process.arch}`,
    electron: (process.versions as Record<string, string>).electron ?? 'see package.json',
    fixturePage: '/heavy/<n> (~2 MB DOM: 6000-row table)',
    thresholdMB: DISCARD_THRESHOLD_MB,
    exceedsThreshold: exceeds,
    approxPerTabMB: perTab,
    decision: exceeds
      ? 'State-safe discard enabled (TabManager.discardIdle: inactive tabs idle >= settings.discardIdleMinutes, default 30, are closed with webContents.close({waitForBeforeUnload:true}); beforeunload cancels; chrome kept; reload on activation)'
      : 'No eviction/discard needed: 20 heavy tabs stay under the 2 GB working-set budget',
    samples,
  };
  writeFileSync(join(evidenceDir, 'p2-memory.json'), JSON.stringify(report, null, 2), 'utf8');

  const rows = samples
    .map(
      (s) =>
        `| ${s.tabs} | ${s.totalWorkingSetMB} | ${s.totalPrivateMB} | ${s.processes} | ${Object.entries(s.byType)
          .map(([type, b]) => `${type}: ${b.count} (${b.workingSetMB} MB)`)
          .join(', ')} |`,
    )
    .join('\n');
  const md = `# P2 memory measurement (O6)

Generated ${report.generatedAt} on ${report.platform}. Fixture page: ${report.fixturePage}.
Metric: sum of \`workingSetSize\` over \`app.getAppMetrics()\` (all Electron processes), sampled 4 s after every tab reports \`did-stop-loading\`.

| Tabs | Working set (MB) | Private (MB) | Processes | By process type |
|---|---|---|---|---|
${rows}

- Approx. marginal cost per heavy tab: ${perTab ?? 'n/a'} MB.
- Budget (plan §4.1 / O6): 20 tabs ≤ ${DISCARD_THRESHOLD_MB} MB total working set.
- Result: **${exceeds ? 'EXCEEDS' : 'within'} budget** → ${report.decision}.

Re-run with \`npm run measure:tabs\`.
`;
  writeFileSync(join(evidenceDir, 'p2-memory.md'), md, 'utf8');
  console.log(md);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
