import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reviewsDirFor } from '../../src/core/tabReview';

const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(async () => undefined),
  pathExists: vi.fn(async (_p: string) => true),
  execOn: vi.fn(async () => ''),
  addWorkspace: vi.fn((p: string) => p),
  merge: vi.fn(),
  current: {
    claude: { workspaces: [] as string[], workspaceLabels: {} as Record<string, string> },
    local: { workspaceLabels: {} as Record<string, string> },
    workspaces: [] as string[],
  },
}));

vi.mock('node:fs/promises', () => ({ mkdir: mocks.mkdir }));
vi.mock('../../src/main/hosts', () => ({
  hosts: () => ({
    pathExists: mocks.pathExists,
    execOn: mocks.execOn,
    hostById: (id: string) =>
      id === 'wsl:Ubuntu' ? { id, kind: 'wsl', distro: 'Ubuntu', home: '/home/u', mount: '/mnt' } : undefined,
  }),
}));
vi.mock('../../src/main/local/ipc', () => ({ localHost: () => ({ addWorkspace: mocks.addWorkspace }) }));
vi.mock('../../src/main/log', () => ({ log: vi.fn() }));
vi.mock('../../src/main/state', () => ({
  testMode: false,
  state: { settings: { get current() { return mocks.current; }, merge: mocks.merge } },
}));

import { ensureReviewWorkspace } from '../../src/main/review/workspace';

const CWD = process.platform === 'win32' ? 'C:\\work\\reviews' : '/work/reviews';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pathExists.mockResolvedValue(true);
  mocks.current.claude = { workspaces: [], workspaceLabels: {} };
  mocks.current.local = { workspaceLabels: {} };
  mocks.current.workspaces = [];
});

describe('reviewsDirFor', () => {
  it('joins with posix separators', () => {
    expect(reviewsDirFor('/home/u', 'posix')).toBe('/home/u/.agent-workspace/reviews');
  });
  it('joins with win32 separators', () => {
    expect(reviewsDirFor('C:\\Users\\u', 'win32')).toBe('C:\\Users\\u\\.agent-workspace\\reviews');
  });
});

describe('ensureReviewWorkspace', () => {
  it('null cwd creates the default folder and pins it for claude', async () => {
    const res = await ensureReviewWorkspace('local', 'claude', null);
    expect(res.ok && res.created).toBe(true);
    expect(mocks.mkdir).toHaveBeenCalledTimes(1);
    expect(mocks.pathExists).not.toHaveBeenCalled();
    expect(mocks.merge).toHaveBeenCalledWith({
      claude: expect.objectContaining({ workspaces: [expect.any(String)] }),
    });
  });

  it('existing custom cwd: no mkdir, pinned for claude', async () => {
    const res = await ensureReviewWorkspace('local', 'claude', CWD);
    expect(res).toMatchObject({ ok: true, cwd: CWD, created: true });
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(mocks.pathExists).toHaveBeenCalledWith(CWD);
    expect(mocks.merge).toHaveBeenCalledTimes(1);
    expect(mocks.addWorkspace).not.toHaveBeenCalled();
  });

  it('existing custom cwd: pinned for devin via addWorkspace + label', async () => {
    const res = await ensureReviewWorkspace('local', 'devin', CWD);
    expect(res.ok && res.created).toBe(true);
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(mocks.addWorkspace).toHaveBeenCalledTimes(1);
    const pinned = mocks.addWorkspace.mock.calls[0]![0];
    expect(mocks.merge).toHaveBeenCalledWith({ local: { workspaceLabels: { [pinned]: 'Reviews' } } });
    expect(mocks.merge).not.toHaveBeenCalledWith(expect.objectContaining({ claude: expect.anything() }));
  });

  it('missing custom cwd -> cwd-missing, settings untouched', async () => {
    mocks.pathExists.mockResolvedValue(false);
    for (const agent of ['claude', 'devin'] as const) {
      expect(await ensureReviewWorkspace('local', agent, CWD)).toEqual({ ok: false, reason: 'cwd-missing' });
    }
    expect(mocks.merge).not.toHaveBeenCalled();
    expect(mocks.addWorkspace).not.toHaveBeenCalled();
    expect(mocks.mkdir).not.toHaveBeenCalled();
  });

  it('wsl cwd on host local is refused before any existence check', async () => {
    const res = await ensureReviewWorkspace('local', 'claude', '\\\\wsl.localhost\\Ubuntu\\home\\u');
    expect(res).toEqual({ ok: false, reason: 'cwd-missing' });
    expect(mocks.pathExists).not.toHaveBeenCalled();
  });

  it('wsl custom cwd checks existence with an explicit `test -d` exec (works on a just-started distro)', async () => {
    const res = await ensureReviewWorkspace('wsl:Ubuntu', 'claude', '/home/u/proj');
    expect(res.ok).toBe(true);
    expect(res.ok && res.workspacePath).toMatch(/^\\\\wsl\.localhost\\Ubuntu\\/);
    expect(mocks.pathExists).not.toHaveBeenCalled();
    expect(mocks.execOn).toHaveBeenCalledTimes(1);
    expect(mocks.execOn).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'wsl:Ubuntu' }),
      { file: 'test', args: ['-d', '/home/u/proj'], cwd: '/home/u' },
      expect.any(Number),
      { explicit: true },
    );
  });

  it('wsl custom cwd: non-zero exit -> cwd-missing, spawn/timeout error -> io', async () => {
    mocks.execOn.mockRejectedValueOnce(Object.assign(new Error('Command failed'), { code: 1 }));
    expect(await ensureReviewWorkspace('wsl:Ubuntu', 'claude', '/home/u/nope')).toEqual({ ok: false, reason: 'cwd-missing' });
    mocks.execOn.mockRejectedValueOnce(Object.assign(new Error('spawn'), { code: 'ENOENT' }));
    expect(await ensureReviewWorkspace('wsl:Ubuntu', 'claude', '/home/u/x')).toEqual({ ok: false, reason: 'io' });
    mocks.execOn.mockRejectedValueOnce(
      Object.assign(new Error('timeout'), { code: null, killed: true, signal: 'SIGTERM' }),
    );
    expect(await ensureReviewWorkspace('wsl:Ubuntu', 'claude', '/home/u/x')).toEqual({ ok: false, reason: 'io' });
    expect(mocks.merge).not.toHaveBeenCalled();
  });

  it('a local folder already listed with different case is not pinned again', async () => {
    const listed = CWD.toUpperCase();
    mocks.current.claude.workspaces = [listed];
    mocks.current.workspaces = [listed];
    const claude = await ensureReviewWorkspace('local', 'claude', CWD);
    expect(claude).toMatchObject({ ok: true, created: false, workspacePath: listed });
    const devin = await ensureReviewWorkspace('local', 'devin', CWD);
    expect(devin).toMatchObject({ ok: true, created: false, workspacePath: listed });
    expect(mocks.merge).not.toHaveBeenCalled();
    expect(mocks.addWorkspace).not.toHaveBeenCalled();
  });

  it('already pinned -> created:false, no pin writes', async () => {
    const first = await ensureReviewWorkspace('local', 'claude', CWD);
    if (!first.ok) throw new Error('setup');
    mocks.current.claude.workspaces = [first.workspacePath];
    mocks.current.workspaces = [first.workspacePath];
    vi.clearAllMocks();
    mocks.pathExists.mockResolvedValue(true);
    expect((await ensureReviewWorkspace('local', 'claude', CWD))).toMatchObject({ ok: true, created: false });
    expect((await ensureReviewWorkspace('local', 'devin', CWD))).toMatchObject({ ok: true, created: false });
    expect(mocks.merge).not.toHaveBeenCalled();
    expect(mocks.addWorkspace).not.toHaveBeenCalled();
  });
});
