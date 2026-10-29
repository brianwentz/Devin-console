import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import { currentDevinUrl, dndMove, launchApp, readEvents, shellPage, state } from './helpers';
import type { CloudListResult } from '../../src/core/cloudAcp';
import { RAIL_WIDTH, SPLITTER_WIDTH, DEFAULT_SESSIONS_WIDTH } from '../../src/core/layout';

let fixtures: FixtureServers;

test.beforeAll(async () => {
  fixtures = await startFixtureServers();
});

test.afterAll(async () => {
  await fixtures.close();
});

function hooks(app: ElectronApplication) {
  const evaluate = (fn: () => unknown) => app.evaluate(fn);
  return {
    cloudState: () =>
      evaluate(
        () =>
          (globalThis as any).__agentworkspace.cloudState(),
      ) as Promise<{
        status: string;
        sessions: Array<{ id: string; url: string; folder: string | null; parentId: string | null }>;
        folders: string[];
        incompleteFolders?: string[];
        cached: boolean;
      }>,
    cloudRefresh: () => evaluate(() => (globalThis as any).__agentworkspace.cloudRefresh()),
    layoutRects: () =>
      evaluate(() => (globalThis as any).__agentworkspace.layoutRects()) as Promise<{
        devin: { x: number; width: number };
        sessions: { x: number; width: number } | null;
        paneCollapsed: boolean;
      }>,
    setSessionsOpen: (value: boolean) =>
      app.evaluate(
        (_e, v: boolean) => (globalThis as any).__agentworkspace.setSessionsOpen(v),
        value,
      ),
    setWindowSize: (width: number, height: number) =>
      app.evaluate(
        (_e, size: { w: number; h: number }) =>
          (globalThis as any).__agentworkspace.setWindowSize(size.w, size.h),
        { w: width, h: height },
      ),
  };
}

test('cloud session sidebar: data, sections, interactions, geometry', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-'));
  const logFile = join(profile, 'events.jsonl');
  const fixturePath = join(profile, 'cloudSessions.json');
  const raw = JSON.parse(
    readFileSync(resolve(__dirname, '../fixtures/cloudSessions.json'), 'utf8'),
  ) as CloudListResult;
  for (const session of raw.sessions) {
    session.url = `${fixtures.devinUrl}/sessions/${session.id}`;
  }
  writeFileSync(fixturePath, JSON.stringify(raw));

  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    AGENT_WORKSPACE_TEST_CLOUD_SESSIONS: fixturePath,
    AGENT_WORKSPACE_TEST_SESSIONS_OPEN: '1',
  });
  const h = hooks(app);
  try {
    // --- data layer: status ready, fixture loaded -------------------------
    await expect.poll(async () => (await h.cloudState()).status).toBe('ready');
    expect((await h.cloudState()).sessions).toHaveLength(8);
    expect((await h.cloudState()).folders).toEqual([
      'Alpha',
      'Beta',
      'participated',
      'pinned',
    ]);
    // Every folder is listed in full — nothing is partial, so no "Show more".
    expect((await h.cloudState()).incompleteFolders).toEqual([]);

    const page = await shellPage(app);
    await expect(page.locator('#sessionsPanel')).toBeVisible();
    await expect(page.locator('[data-load-more]')).toHaveCount(0);

    // --- (1) section order: pinned, folders minus 'pinned', extras, recent --
    const names = await page
      .locator('[data-section-name]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-section-name')));
    expect(names).toEqual(['pinned', 'Alpha', 'Beta', 'participated', 'recent']);

    // --- (2) children nest under the parent; orphan is a root -------------
    const alphaRows = page.locator('[data-session-id]');
    const rowIds = await alphaRows.evaluateAll((els) =>
      els.map((el) => `${el.getAttribute('data-session-id')}:${el.getAttribute('data-depth')}`),
    );
    // Pinned section first (pinned root), then Alpha: bbbb root + its two
    // children (depth 1) directly after it, then the orphan at depth 0.
    const rootIdx = rowIds.indexOf('bbbb0000000000000000000000000002:0');
    expect(rootIdx).toBeGreaterThan(0);
    expect(rowIds[rootIdx + 1]).toBe('cccc0000000000000000000000000003:1');
    expect(rowIds[rootIdx + 2]).toBe('dddd0000000000000000000000000004:1');
    expect(rowIds).toContain('eeee0000000000000000000000000005:0');

    // Rows use the shared 12px token (same as the web sidebar's text-xs).
    await expect
      .poll(() =>
        page
          .locator('[data-session-id]')
          .first()
          .evaluate((el) => getComputedStyle(el).fontSize),
      )
      .toBe('12px');

    // --- screenshot evidence (all sections expanded, full fixture) --------
    const evidenceDir = resolve(process.cwd(), 'docs', 'evidence');
    mkdirSync(evidenceDir, { recursive: true });
    await page.screenshot({ path: join(evidenceDir, 'sessions-sidebar.png') });

    // --- (3) collapse persists via settings -------------------------------
    await page.locator('[data-section-name="Alpha"]').click();
    await expect
      .poll(
        async () =>
          ((await state(app)).settings as unknown as { sessions: { collapsedFolders: string[] } })
            .sessions.collapsedFolders,
      )
      .toContain('Alpha');
    await expect(
      page.locator('[data-session-id="bbbb0000000000000000000000000002"]'),
    ).toHaveCount(0);
    // survives a surface round-trip
    await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('settings'));
    await expect(page.locator('#sessionsPanel')).toHaveCount(0);
    await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('cloud'));
    await expect(page.locator('#sessionsPanel')).toBeVisible();
    await expect(
      page.locator('[data-session-id="bbbb0000000000000000000000000002"]'),
    ).toHaveCount(0);
    // expand again for the following assertions
    await page.locator('[data-section-name="Alpha"]').click();
    await expect(
      page.locator('[data-session-id="bbbb0000000000000000000000000002"]'),
    ).toBeVisible();

    // --- (4) row click navigates the devin view + marks current -----------
    const target = raw.sessions.find((s) => s.folder === null)!;
    await page.locator(`[data-session-id="${target.id}"]`).click();
    await expect.poll(() => currentDevinUrl(app, fixtures)).toBe(target.url);
    await expect.poll(async () => (await state(app)).currentSessionId).toBe(target.id);
    await expect(
      page.locator(`[data-session-id="${target.id}"]`),
    ).toHaveAttribute('data-current', 'true');

    // --- (5) sessions column toggle hides the column and shifts devin.x ---
    await h.setSessionsOpen(false);
    await expect.poll(async () => (await h.layoutRects()).sessions).toBeNull();
    expect((await h.layoutRects()).devin.x).toBe(RAIL_WIDTH);
    await h.setSessionsOpen(true);
    await expect
      .poll(async () => (await h.layoutRects()).devin.x)
      .toBe(RAIL_WIDTH + DEFAULT_SESSIONS_WIDTH + SPLITTER_WIDTH);

    // --- (6) search filters to a flat matching list -----------------------
    await page.locator('#sessionSearch').fill('Recent one');
    await expect
      .poll(async () => page.locator('[data-session-id]').count())
      .toBe(1);
    await expect(
      page.locator('[data-session-id="22220000000000000000000000000000"]'),
    ).toBeVisible();
    await page.locator('#sessionSearch').fill('');
    await expect
      .poll(async () => page.locator('[data-session-id]').count())
      .toBeGreaterThan(5);

    // --- (7) narrow window collapses the column (and the pane) ------------
    // The pane-open min width (1000) blocks shrinking to 900 — close the pane
    // first so the window can actually get that narrow.
    await app.evaluate(() => (globalThis as any).__agentworkspace.setPaneOpen(false));
    await h.setWindowSize(900, 800);
    await expect.poll(async () => (await state(app)).sessionsCollapsed).toBe(true);
    await expect(page.locator('#sessionsPanel')).toHaveCount(0);
    await h.setWindowSize(1400, 900);
    await app.evaluate(() => (globalThis as any).__agentworkspace.setPaneOpen(true));
    await expect.poll(async () => (await state(app)).sessionsCollapsed).toBe(false);
    await expect(page.locator('#sessionsPanel')).toBeVisible();

    // --- fixture mutation → refresh --------------------------------------
    raw.sessions = raw.sessions.slice(0, 5);
    raw.folders = ['Alpha', 'pinned'];
    writeFileSync(fixturePath, JSON.stringify(raw));
    await h.cloudRefresh();
    await expect.poll(async () => (await h.cloudState()).sessions.length).toBe(5);
    expect((await h.cloudState()).folders).toEqual(['Alpha', 'pinned']);
  } finally {
    await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('cloud session sidebar: cached list renders while connecting', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-'));
  const logFile = join(profile, 'events.jsonl');
  const raw = JSON.parse(
    readFileSync(resolve(__dirname, '../fixtures/cloudSessions.json'), 'utf8'),
  ) as CloudListResult;
  for (const session of raw.sessions) {
    session.url = `${fixtures.devinUrl}/sessions/${session.id}`;
  }
  // CloudCache shape — the data layer reads it instead of the fixture file.
  const cachePath = join(profile, 'cloud-cache.json');
  writeFileSync(
    cachePath,
    JSON.stringify({
      version: 1,
      tenantUrl: fixtures.devinUrl,
      savedAt: new Date().toISOString(),
      sessions: raw.sessions,
      folders: raw.folders,
      folderTotals: raw.folderTotals,
    }),
  );

  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    AGENT_WORKSPACE_TEST_CLOUD_CACHE: cachePath,
    AGENT_WORKSPACE_TEST_SESSIONS_OPEN: '1',
  });
  const h = hooks(app);
  try {
    await expect.poll(async () => (await h.cloudState()).status).toBe('connecting');
    expect((await h.cloudState()).cached).toBe(true);
    expect((await h.cloudState()).sessions).toHaveLength(8);

    const page = await shellPage(app);
    await expect(page.locator('#sessionsPanel')).toBeVisible();
    await expect(page.locator('#cloudStatus')).toHaveAttribute(
      'data-cloud-status',
      'connecting',
    );
    await expect(page.locator('#cloudStatus')).toHaveAttribute(
      'data-cloud-cached',
      'true',
    );
    await expect(page.locator('#cloudStatus')).toContainText('cached');
    await expect.poll(async () => page.locator('[data-session-id]').count()).toBe(8);
    // A cached list is never marked partial.
    expect((await h.cloudState()).incompleteFolders).toEqual([]);
    await expect(page.locator('[data-load-more]')).toHaveCount(0);
  } finally {
    await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('cloud session sidebar: folders and children show in full', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-cloud-paging-'));
  const logFile = join(profile, 'events.jsonl');
  const fixturePath = join(profile, 'cloudSessions.json');
  const raw = JSON.parse(
    readFileSync(resolve(__dirname, '../fixtures/cloudSessions.json'), 'utf8'),
  ) as CloudListResult & {
    paging?: { pageSize: number; folders: Record<string, CloudListResult['sessions']> };
  };
  for (const session of raw.sessions) {
    session.url = `${fixtures.devinUrl}/sessions/${session.id}`;
  }
  // Gamma: 7 roots on the server; page 1 (the fixture head) carries the first
  // pageSize (3) of them — a full slice, so the folder pages. G1 (the 5th
  // root) only arrives on a folder page, with all 11 of its children.
  const seed = raw.sessions.find((s) => s.folder === 'Alpha' && !s.isPinned && s.parentId === null)!;
  const hex = (prefix: string, n: number) => `${prefix}${String(n).padStart(32 - prefix.length, '0')}`;
  const row = (id: string, title: string, parentId: string | null, updatedAt: number, children = 0) => ({
    ...seed,
    id,
    acpId: `devin-${id}`,
    title,
    url: `${fixtures.devinUrl}/sessions/${id}`,
    folder: 'Gamma',
    parentId,
    isPinned: false,
    isUnread: false,
    directChildrenCount: children,
    hasMoreChildren: false,
    updatedAt,
  });
  const g1 = hex('9a', 5);
  const gammaRoots = [1, 2, 3, 4, 5, 6, 7].map((n) =>
    row(hex('9a', n), `Gamma root ${n}`, null, 1759800000000 - n * 1000, n === 5 ? 11 : 0),
  );
  const g1Children = Array.from({ length: 11 }, (_, i) =>
    row(hex('9c', i + 1), `Gamma child ${i + 1}`, g1, 1759700000000 - i * 1000),
  );
  raw.sessions.push(...gammaRoots.slice(0, 3));
  raw.folders = ['Alpha', 'Beta', 'Gamma', 'participated', 'pinned'];
  raw.folderTotals = { ...raw.folderTotals, Gamma: 7 };
  raw.paging = { pageSize: 3, folders: { Gamma: [...gammaRoots, ...g1Children] } };
  writeFileSync(fixturePath, JSON.stringify(raw));
  const titles = [...raw.sessions, ...gammaRoots, ...g1Children].map((s) => s.title);

  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    AGENT_WORKSPACE_TEST_CLOUD_SESSIONS: fixturePath,
    AGENT_WORKSPACE_TEST_SESSIONS_OPEN: '1',
  });
  const h = hooks(app);
  const gammaShape = async () => {
    const cloud = await h.cloudState();
    return {
      roots: cloud.sessions.filter((s) => s.folder === 'Gamma' && s.parentId === null).length,
      children: cloud.sessions.filter((s) => s.parentId === g1).length,
      incomplete: cloud.incompleteFolders,
    };
  };
  const full = { roots: 7, children: 11, incomplete: [] };
  try {
    await expect.poll(async () => (await h.cloudState()).status).toBe('ready');
    await expect.poll(gammaShape).toEqual(full);

    const page = await shellPage(app);
    await expect(page.locator('#sessionsPanel')).toBeVisible();
    const expectRowsInFull = async () => {
      for (const root of gammaRoots) {
        await expect(page.locator(`[data-session-id="${root.id}"]`)).toHaveAttribute('data-depth', '0');
      }
      for (const child of g1Children) {
        await expect(page.locator(`[data-session-id="${child.id}"]`)).toHaveAttribute('data-depth', '1');
      }
      await expect(page.locator('[data-load-more]')).toHaveCount(0);
    };
    await expectRowsInFull();

    await expect
      .poll(async () =>
        (await readEvents(logFile)).some(
          (e) =>
            e.event === 'cloud-folder-paging' &&
            (e.detail as { incomplete?: number; pages?: number }).incomplete === 0 &&
            ((e.detail as { pages?: number }).pages ?? 0) > 0,
        ),
      )
      .toBe(true);

    // A later list must not drop the paged-in rows.
    await h.cloudRefresh();
    await expect.poll(gammaShape).toEqual(full);
    await expectRowsInFull();

    // Folder names and titles never reach the event log.
    const text = readFileSync(logFile, 'utf8');
    expect(text).not.toContain('Gamma');
    for (const title of titles) expect(text).not.toContain(title);
  } finally {
    await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});

type MenuItem = {
  id: string;
  label: string;
  type: string;
  enabled: boolean;
  checked?: boolean;
  submenu?: MenuItem[];
};

function findMenuItem(items: MenuItem[], label: string): MenuItem | null {
  for (const item of items) {
    if (item.label === label) return item;
    const hit = item.submenu ? findMenuItem(item.submenu, label) : null;
    if (hit) return hit;
  }
  return null;
}

test('cloud session sidebar: mutations, menus, PR badges', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-'));
  const logFile = join(profile, 'events.jsonl');
  const fixturePath = join(profile, 'cloudSessions.json');
  const raw = JSON.parse(
    readFileSync(resolve(__dirname, '../fixtures/cloudSessions.json'), 'utf8'),
  ) as CloudListResult;
  for (const session of raw.sessions) {
    session.url = `${fixtures.devinUrl}/sessions/${session.id}`;
  }
  writeFileSync(fixturePath, JSON.stringify(raw));

  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    AGENT_WORKSPACE_TEST_CLOUD_SESSIONS: fixturePath,
    AGENT_WORKSPACE_TEST_SESSIONS_OPEN: '1',
  });
  const h = hooks(app);
  const evaluate = (fn: () => unknown) => app.evaluate(fn);
  const mutations = () =>
    evaluate(() => (globalThis as any).__agentworkspace.cloudMutations()) as Promise<
      { op: string; payload: { method: string; path: string; body?: unknown } }[]
    >;
  const menuItems = () =>
    evaluate(() => (globalThis as any).__agentworkspace.cloudMenuItems()) as Promise<
      MenuItem[]
    >;
  const menuClick = (id: string) =>
    app.evaluate((_e, itemId) => (globalThis as any).__agentworkspace.cloudMenuClick(itemId), id);
  const clipboardRead = () =>
    evaluate(() => (globalThis as any).__agentworkspace.clipboardRead()) as Promise<string>;

  try {
    await expect.poll(async () => (await h.cloudState()).status).toBe('ready');
    const page = await shellPage(app);
    await expect(page.locator('#sessionsPanel')).toBeVisible();

    // --- PR badge attrs ---------------------------------------------------
    await expect(
      page.locator('[data-session-id="aaaa0000000000000000000000000001"]'),
    ).toHaveAttribute('data-pr-open', '1');
    await expect(
      page.locator('[data-session-id="eeee0000000000000000000000000005"]'),
    ).toHaveAttribute('data-pr-merged', '1');

    // --- create folder via the + inline editor ----------------------------
    await page.locator('#sessionFolderNew').click();
    await page.locator('#sessionFolderEdit').fill('ZZ E2E');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-section-name="ZZ E2E"]')).toBeVisible();
    expect(
      (await mutations()).some(
        (m) =>
          m.op === 'folder-create' &&
          (m.payload.body as { folder: string }).folder === 'ZZ E2E',
      ),
    ).toBe(true);

    // --- right-click → Copy link ------------------------------------------
    const recentRow = page.locator('[data-session-id="22220000000000000000000000000000"]');
    await recentRow.click({ button: 'right' });
    const copy = findMenuItem(await menuItems(), 'Copy link');
    expect(copy).toBeTruthy();
    await menuClick(copy!.id);
    const expectedLink = `${fixtures.devinUrl}/sessions/22220000000000000000000000000000`;
    expect(
      (await mutations()).some(
        (m) =>
          m.op === 'copy-link' &&
          (m.payload as unknown as { link: string }).link === expectedLink,
      ),
    ).toBe(true);
    await expect.poll(clipboardRead).toBe(expectedLink);

    // --- archive removes the row; Show archived restores it dimmed --------
    await recentRow.click({ button: 'right' });
    const archive = findMenuItem(await menuItems(), 'Archive');
    await menuClick(archive!.id);
    await expect(recentRow).toHaveCount(0);
    await page.locator('#sessionsMenu').click();
    const showArchived = findMenuItem(await menuItems(), 'Show archived sessions');
    await menuClick(showArchived!.id);
    await expect(recentRow).toHaveAttribute('data-archived', 'true');

    // --- DnD: session onto a folder header moves it -----------------------
    await dndMove(
      page,
      '[data-session-id="33330000000000000000000000000000"]',
      '[data-section-name="Alpha"]',
    );
    await expect
      .poll(async () =>
        (await mutations()).some(
          (m) =>
            m.op === 'session-move' &&
            m.payload.method === 'POST' &&
            (m.payload.body as { folder: string }).folder === 'Alpha' &&
            (m.payload.body as { devin_id: string }).devin_id ===
              'devin-33330000000000000000000000000000',
        ),
      )
      .toBe(true);

    // --- DnD: back onto Recent removes it ---------------------------------
    await dndMove(
      page,
      '[data-session-id="33330000000000000000000000000000"]',
      '[data-section-name="recent"]',
    );
    await expect
      .poll(async () =>
        (await mutations()).some(
          (m) =>
            m.op === 'session-move' &&
            m.payload.method === 'DELETE' &&
            m.payload.path === 'sessions/folder/devin-33330000000000000000000000000000',
        ),
      )
      .toBe(true);

    // --- DnD: folder header onto another header reorders ------------------
    await dndMove(page, '[data-section-name="Beta"]', '[data-section-name="Alpha"]');
    await expect
      .poll(async () => {
        const reorder = (await mutations()).find((m) => m.op === 'folder-reorder');
        return (reorder?.payload.body as { folder_names: string[] } | undefined)
          ?.folder_names;
      })
      .toEqual(['Beta', 'Alpha', 'ZZ E2E']);
    // The section order reflects it in the DOM too.
    await expect
      .poll(async () =>
        page
          .locator('[data-section-name]')
          .evaluateAll((els) => els.map((el) => el.getAttribute('data-section-name'))),
      )
      .toEqual(['pinned', 'Beta', 'Alpha', 'ZZ E2E', 'participated', 'recent']);

    // --- move a foldered session out via the menu -------------------------
    // 'participated' is a system folder but a valid move target in the web.
    const foldered = page.locator('[data-session-id="bbbb0000000000000000000000000002"]');
    await foldered.click({ button: 'right' });
    const menu = await menuItems();
    const participated = findMenuItem(menu, 'participated');
    expect(participated).toBeTruthy();
    await menuClick(participated!.id);
    await expect
      .poll(async () =>
        (await mutations()).some(
          (m) =>
            m.op === 'session-move' &&
            (m.payload.body as { folder?: string } | undefined)?.folder ===
              'participated',
        ),
      )
      .toBe(true);
    await expect
      .poll(async () =>
        page
          .locator(
            'xpath=//*[@data-section-name="participated"]/ancestor::div[1]//*[@data-session-id="bbbb0000000000000000000000000002"]',
          )
          .count(),
      )
      .toBe(1);
    // move it back to Alpha so later steps see the fixture order
    await dndMove(
      page,
      '[data-session-id="bbbb0000000000000000000000000002"]',
      '[data-section-name="Alpha"]',
    );

    // --- DnD onto participated header is a move target --------------------
    await dndMove(
      page,
      '[data-session-id="eeee0000000000000000000000000005"]',
      '[data-section-name="participated"]',
    );
    await expect
      .poll(async () =>
        (await mutations()).filter(
          (m) =>
            m.op === 'session-move' &&
            (m.payload.body as { folder?: string } | undefined)?.folder ===
              'participated',
        ).length,
      )
      .toBe(2);

    // --- folder headers cannot be dropped/reordered onto participated -----
    await dndMove(page, '[data-section-name="Alpha"]', '[data-section-name="participated"]');
    await expect(
      page.locator('[data-section-name="participated"]'),
    ).toHaveAttribute('data-drop-before', 'false');

    // --- folder context menu: Rename… resolves to the inline-edit action --
    await page.locator('[data-section-name="Beta"]').click({ button: 'right' });
    const rename = findMenuItem(await menuItems(), 'Rename…');
    expect(rename).toBeTruthy();
    const renameResult = (await app.evaluate(
      (_e, id) => (globalThis as any).__agentworkspace.cloudMenuClick(id),
      rename!.id,
    )) as { action: string | null };
    expect(renameResult.action).toBe('rename');

    // --- New session: menus, header button, per-folder +, home→session file -
    await page.locator('#sessionsMenu').click();
    expect(findMenuItem(await menuItems(), 'New session')).toBeTruthy();
    await page.locator('[data-section-name="Beta"]').click({ button: 'right' });
    expect(findMenuItem(await menuItems(), 'New session in folder')).toBeTruthy();

    // Header button: pending folder null, composer loads on the tenant root.
    await page.locator('#sessionNew').click();
    expect(
      (await mutations()).some(
        (m) =>
          m.op === 'new-session' &&
          (m.payload as unknown as { folder: string | null }).folder === null,
      ),
    ).toBe(true);
    await expect.poll(() => currentDevinUrl(app, fixtures)).toBe(`${fixtures.devinUrl}/`);

    // Per-folder +: hover reveals it; a home→session navigation arms a watch —
    // nothing files until the backend lists the new session.
    await page.locator('[data-section-name="Alpha"]').hover();
    await page.locator('[data-folder-new-session="Alpha"]').click();
    expect(
      (await mutations()).some(
        (m) =>
          m.op === 'new-session' &&
          (m.payload as unknown as { folder: string | null }).folder === 'Alpha',
      ),
    ).toBe(true);
    await evaluate(
      () => (globalThis as any).__agentworkspace.cloudNoteHomeNavigation('abc123'),
    );
    const movedTo = (id: string, folder: string | null) =>
      mutations().then((ms) =>
        ms.some(
          (m) =>
            m.op === 'session-move' &&
            m.payload.method === 'POST' &&
            m.payload.path === 'sessions/folder' &&
            (m.payload.body as { devin_id: string }).devin_id === `devin-${id}` &&
            (m.payload.body as { folder: string | null }).folder === folder,
        ),
      );
    expect(await movedTo('abc123', 'Alpha')).toBe(false);

    // Backend catches up: the session appears in the fixture, refresh files it.
    const seed = raw.sessions.find((s) => s.folder === null)!;
    raw.sessions.push({
      ...seed,
      id: 'abc123',
      acpId: 'devin-abc123',
      title: 'Watched new session',
      url: `${fixtures.devinUrl}/sessions/abc123`,
      folder: null,
      isPinned: false,
    });
    writeFileSync(fixturePath, JSON.stringify(raw));
    await h.cloudRefresh();
    await expect.poll(() => movedTo('abc123', 'Alpha')).toBe(true);

    // Top-level new session: the watch still updates the sidebar, files nothing.
    await app.evaluate(
      () => (globalThis as any).__agentworkspace.cloudNewSession(null),
    );
    await evaluate(
      () => (globalThis as any).__agentworkspace.cloudNoteHomeNavigation('def456'),
    );
    raw.sessions.push({
      ...seed,
      id: 'def456',
      acpId: 'devin-def456',
      title: 'Top-level new session',
      url: `${fixtures.devinUrl}/sessions/def456`,
      folder: null,
      isPinned: false,
    });
    writeFileSync(fixturePath, JSON.stringify(raw));
    await h.cloudRefresh();
    await expect(page.locator('[data-session-id="def456"]')).toBeVisible();
    expect(
      (await mutations()).some(
        (m) =>
          m.op === 'session-move' &&
          (m.payload.body as { devin_id?: string } | undefined)?.devin_id === 'devin-def456',
      ),
    ).toBe(false);

    // Navigating home to an ALREADY-listed session files nothing.
    const sessionMoveCount = (await mutations()).filter(
      (m) => m.op === 'session-move',
    ).length;
    await app.evaluate(
      (_e, folder) => (globalThis as any).__agentworkspace.cloudNewSession(folder),
      'Beta',
    );
    await app.evaluate(
      (_e, id) => (globalThis as any).__agentworkspace.cloudNoteHomeNavigation(id),
      'aaaa0000000000000000000000000001',
    );
    expect(
      (await mutations()).filter((m) => m.op === 'session-move'),
    ).toHaveLength(sessionMoveCount);
  } finally {
    await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});

// ux3 S1: drag session rows to reorder inside a user folder and Recent.
test('cloud session sidebar: session row drag reorders inside a folder and recent', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-cloud-reorder-'));
  const fixturePath = join(profile, 'cloudSessions.json');
  const raw = JSON.parse(
    readFileSync(resolve(__dirname, '../fixtures/cloudSessions.json'), 'utf8'),
  ) as CloudListResult;
  for (const session of raw.sessions) {
    session.url = `${fixtures.devinUrl}/sessions/${session.id}`;
  }
  // Two extra Alpha roots (the fixture's other Alpha rows are children) so the
  // section has four reorderable roots: bbbb, eeee, a100, a200.
  const seed = raw.sessions.find((s) => s.folder === 'Alpha' && !s.isPinned)!;
  raw.sessions.push(
    { ...seed, id: 'a1000000000000000000000000000001', acpId: 'devin-a1000000000000000000000000000001', title: 'Alpha extra 1', url: `${fixtures.devinUrl}/sessions/a1000000000000000000000000000001`, isPinned: false, parentId: null, updatedAt: 1759525000000 },
    { ...seed, id: 'a2000000000000000000000000000002', acpId: 'devin-a2000000000000000000000000000002', title: 'Alpha extra 2', url: `${fixtures.devinUrl}/sessions/a2000000000000000000000000000002`, isPinned: false, parentId: null, updatedAt: 1759524000000 },
  );
  writeFileSync(fixturePath, JSON.stringify(raw));
  const logFile = join(profile, 'events.jsonl');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    AGENT_WORKSPACE_TEST_CLOUD_SESSIONS: fixturePath,
    AGENT_WORKSPACE_TEST_SESSIONS_OPEN: '1',
  });
  const h = hooks(app);
  const orderIn = async (section: string) => {
    const page = await shellPage(app);
    return page.evaluate((sec) => {
      const header = [...document.querySelectorAll('[data-section-name]')].find(
        (e) => e.getAttribute('data-section-name') === sec,
      );
      const wrap = header?.closest('div.mb-px');
      return [...(wrap?.querySelectorAll('[data-reorder-row]') ?? [])].map((e) =>
        e.getAttribute('data-reorder-row'),
      );
    }, section);
  };
  try {
    await expect.poll(async () => (await h.cloudState()).status).toBe('ready');
    const page = await shellPage(app);
    await expect.poll(async () => (await orderIn('Alpha')).length).toBe(4);

    // drag the last Alpha row above the first → DOM order + settings.
    const alpha = await orderIn('Alpha');
    await dndMove(
      page,
      `[data-session-id="${alpha[3]}"]`,
      `[data-session-id="${alpha[0]}"]`,
    );
    const expectedAlpha = [alpha[3], alpha[0], alpha[1], alpha[2]];
    await expect.poll(async () => orderIn('Alpha')).toEqual(expectedAlpha);
    await expect
      .poll(
        () =>
          (JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8')) as any)
            ?.sessions?.sessionOrder?.Alpha,
      )
      .toEqual(expectedAlpha);

    // same inside Recent (folder:null rows): drag the older above the newer.
    const recent = await orderIn('recent');
    await dndMove(
      page,
      `[data-session-id="${recent[1]}"]`,
      `[data-session-id="${recent[0]}"]`,
    );
    const expectedRecent = [recent[1], recent[0]];
    await expect.poll(async () => orderIn('recent')).toEqual(expectedRecent);
    await expect
      .poll(
        () =>
          (JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8')) as any)
            ?.sessions?.sessionOrder?.recent,
      )
      .toEqual(expectedRecent);

    // a session that arrives later still lists above the manual order.
    const seedRow = raw.sessions.find((s) => s.folder === 'Alpha')!;
    raw.sessions.push({
      ...seedRow,
      id: 'eeee9999eeee9999eeee9999eeee9999',
      acpId: 'devin-eeee9999eeee9999eeee9999eeee9999',
      title: 'Newest session',
      url: `${fixtures.devinUrl}/sessions/eeee9999eeee9999eeee9999eeee9999`,
      isPinned: false,
      updatedAt: 1759800000000,
    });
    writeFileSync(fixturePath, JSON.stringify(raw));
    await h.cloudRefresh();
    await expect
      .poll(async () => (await orderIn('Alpha'))[0])
      .toBe('eeee9999eeee9999eeee9999eeee9999');
    expect((await orderIn('Alpha')).slice(1)).toEqual(expectedAlpha);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});
