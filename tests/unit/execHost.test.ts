import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadHelperBundleInfo } from '../../src/main/helperBundle';
import { isRemoteFsPath } from '../../src/main/remoteFsGuard';
import {
  canonicalSshAlias,
  isRemoteHost,
  isSshPathLike,
  normalizeSshPath,
  parseSshEnvProbe,
  sshCommandSpec,
  sshEnvSpec,
  sshProbeSpec,
  sshEnvLine,
  sshEnvFileContent,
  sshForwardSpec,
  sshFailureClass,
  sshRecoveryDue,
  SSH_RUN_STDIN_SCRIPT,
  SSH_RUN_FILE_SCRIPT,
  normalizeWorkspacePath,
  INVALID_SSH_PATH_MESSAGE,
  deriveHelperState,
  displayPath,
  helperDeploySpec,
  helperSpec,
  isSshHost,
  parseSshUri,
  sshHelperDeploySpec,
  sshHelperSpec,
  sshHost,
  sshPtySpec,
  sshQuote,
  sshSpawnSpec,
  workspaceLabel,
  parseHelperHash,
  parseHelperPresent,
  parseProbeOutput,
  probeLine,
  posixQuote,
  sanitizeEnv,
  hostIdForPath,
  isFsReady,
  isWslHost,
  shellFamily,
  LOCAL_HOST,
  mergeShellEnv,
  parseShellEnv,
  parseWslList,
  ptySpec,
  resolveLocalConfigDir,
  spawnSpec,
  toHostPath,
  toWindowsPath,
  WSL_ENV_DENYLIST,
  wslHost,
} from '../../src/core/execHost';

const UB = wslHost('Ubuntu-22.04', '/home/brian');

describe('hostIdForPath', () => {
  it('maps wsl.localhost and wsl$ UNCs to the distro host', () => {
    expect(hostIdForPath('\\\\wsl.localhost\\Ubuntu-22.04\\home\\brian\\x')).toBe('wsl:Ubuntu-22.04');
    expect(hostIdForPath('\\\\wsl$\\Ubuntu-22.04\\home\\brian')).toBe('wsl:Ubuntu-22.04');
  });
  it('accepts forward-slash spellings and is case-insensitive on the server', () => {
    expect(hostIdForPath('//wsl.localhost/Ubuntu-22.04/home/brian')).toBe('wsl:Ubuntu-22.04');
    expect(hostIdForPath('//WSL.LOCALHOST/Ubuntu-22.04/home')).toBe('wsl:Ubuntu-22.04');
    expect(hostIdForPath('\\\\WSL$\\d\\x')).toBe('wsl:d');
  });
  it('handles distro names with dots and dashes', () => {
    expect(hostIdForPath('\\\\wsl.localhost\\Ubuntu.Dev-Box\\x')).toBe('wsl:Ubuntu.Dev-Box');
  });
  it('returns local for drive, relative, POSIX and non-wsl UNC paths', () => {
    expect(hostIdForPath('C:\\Users\\brian')).toBe('local');
    expect(hostIdForPath('/home/brian')).toBe('local');
    expect(hostIdForPath('\\\\server\\share\\x')).toBe('local');
    expect(hostIdForPath('src/x')).toBe('local');
  });
});

describe('extended-length UNC (\\\\?\\UNC\\) forms (R33)', () => {
  it('map to the wsl host, case-insensitively, for both servers', () => {
    expect(hostIdForPath('\\\\?\\UNC\\wsl.localhost\\Ubuntu-22.04\\home\\b')).toBe('wsl:Ubuntu-22.04');
    expect(hostIdForPath('\\\\?\\unc\\WSL$\\Ubuntu-22.04\\home')).toBe('wsl:Ubuntu-22.04');
    expect(hostIdForPath('\\\\?\\UNC\\server\\share\\x')).toBe('local');
    expect(hostIdForPath('\\\\?\\C:\\x')).toBe('local');
  });
  it('toHostPath strips the extended prefix', () => {
    expect(toHostPath(UB, '\\\\?\\UNC\\wsl.localhost\\Ubuntu-22.04\\home\\b\\x')).toBe('/home/b/x');
    expect(toHostPath(UB, '\\\\?\\unc\\wsl$\\Ubuntu-22.04\\home')).toBe('/home');
  });
  // The guard folds case/slashes only on Windows (UNC paths exist nowhere else),
  // same as the win32-only case test in remoteFsGuard.test.ts.
  it.runIf(process.platform === 'win32')('the remote-fs guard already matches the extended forms', () => {
    expect(isRemoteFsPath('\\\\?\\UNC\\wsl.localhost\\D\\x', [])).toBe(true);
    expect(isRemoteFsPath('\\\\?\\UNC\\wsl$\\D\\x', [])).toBe(true);
  });
});

describe('toHostPath', () => {
  it('local is identity', () => {
    expect(toHostPath(LOCAL_HOST, 'C:\\a\\b')).toBe('C:\\a\\b');
  });
  it('strips the UNC prefix for the owning distro', () => {
    expect(toHostPath(UB, '\\\\wsl.localhost\\Ubuntu-22.04\\home\\b\\x')).toBe('/home/b/x');
    expect(toHostPath(UB, '\\\\wsl$\\Ubuntu-22.04\\home\\b')).toBe('/home/b');
    expect(toHostPath(UB, '//wsl.localhost/Ubuntu-22.04/home/b')).toBe('/home/b');
  });
  it('maps the distro root to /', () => {
    expect(toHostPath(UB, '\\\\wsl.localhost\\Ubuntu-22.04\\')).toBe('/');
    expect(toHostPath(UB, '//wsl.localhost/Ubuntu-22.04/')).toBe('/');
  });
  it('converts drive paths under the automount root', () => {
    expect(toHostPath(UB, 'C:\\Users\\b')).toBe('/mnt/c/Users/b');
    expect(toHostPath(UB, 'D:/x')).toBe('/mnt/d/x');
    expect(toHostPath(UB, 'C:\\')).toBe('/mnt/c');
    expect(toHostPath(wslHost('D', null, '/custom'), 'C:\\x')).toBe('/custom/c/x');
  });
  it('passes POSIX paths through and collapses duplicate slashes', () => {
    expect(toHostPath(UB, '/home/b/x')).toBe('/home/b/x');
    expect(toHostPath(UB, '\\\\wsl.localhost\\Ubuntu-22.04\\home\\\\b')).toBe('/home/b');
  });
});

describe('toWindowsPath', () => {
  it('local is identity', () => {
    expect(toWindowsPath(LOCAL_HOST, '/x')).toBe('/x');
  });
  it('maps automounted drive paths back to drive letters', () => {
    expect(toWindowsPath(UB, '/mnt/c/Users/b')).toBe('C:\\Users\\b');
    expect(toWindowsPath(UB, '/mnt/d')).toBe('D:\\');
    expect(toWindowsPath(wslHost('D', null, '/custom'), '/custom/c/x')).toBe('C:\\x');
  });
  it('maps other POSIX paths to the wsl.localhost UNC', () => {
    expect(toWindowsPath(UB, '/home/brian/src')).toBe('\\\\wsl.localhost\\Ubuntu-22.04\\home\\brian\\src');
    expect(toWindowsPath(UB, '/')).toBe('\\\\wsl.localhost\\Ubuntu-22.04\\');
  });
  it('round-trips /mnt/c paths both ways', () => {
    const win = 'C:\\Users\\brian\\src';
    expect(toWindowsPath(UB, toHostPath(UB, win))).toBe(win);
    const posix = '/mnt/c/Users/brian';
    expect(toHostPath(UB, toWindowsPath(UB, posix))).toBe(posix);
  });
});

describe('displayPath', () => {
  it('prefixes the distro only for wsl hosts when several hosts exist', () => {
    expect(displayPath(UB, '/home/b/src', true)).toBe('Ubuntu-22.04 · /home/b/src');
    expect(displayPath(UB, '/home/b/src', false)).toBe('/home/b/src');
    expect(displayPath(LOCAL_HOST, 'C:\\x', true)).toBe('C:\\x');
  });
});

describe('parseShellEnv', () => {
  const marker = '__DW_ENV__';
  const cap = (body: string, prefix = 'chatter on stdout\n') =>
    parseShellEnv(`${prefix}\x00${marker}\x00${body}`, marker);

  it('parses NUL-separated K=V after the marker', () => {
    expect(cap('A=1\x00B=two\x00')).toEqual({ A: '1', B: 'two' });
  });
  it('returns null when the marker is absent', () => {
    expect(parseShellEnv('A=1\x00B=2', marker)).toBeNull();
    expect(parseShellEnv('', marker)).toBeNull();
  });
  it('decodes Uint8Array input as utf-8', () => {
    const bytes = new TextEncoder().encode(`x\x00${marker}\x00K=v\x00`);
    expect(parseShellEnv(bytes, marker)).toEqual({ K: 'v' });
  });
  it('tolerates a NUL inside a value and = in values', () => {
    expect(cap('P=a=b=c\x00')).toEqual({ P: 'a=b=c' });
    expect(cap('X=\x00Y=2\x00')).toEqual({ X: '', Y: '2' });
  });
  it('skips entries without = and keys that are not identifiers', () => {
    expect(cap('NOEQ\x00-2BAD=1\x00GOOD=ok\x009X=n\x00=emptykey\x00')).toEqual({ GOOD: 'ok' });
  });
  it('accepts leading-underscore keys', () => {
    expect(cap('_X=1\x00')).toEqual({ _X: '1' });
  });
});

describe('mergeShellEnv', () => {
  it('drops denylisted vars from the capture', () => {
    const captured: Record<string, string> = { PATH: '/bin' };
    for (const key of WSL_ENV_DENYLIST) {
      captured[key] = 'x';
    }
    const merged = mergeShellEnv(captured, {});
    expect(merged).toEqual({ PATH: '/bin' });
  });
  it('overlays extra, which wins and is never dropped', () => {
    const merged = mergeShellEnv(
      { PATH: '/a', TOKEN: 'old' },
      { PATH: '/b', WSLENV: 'kept', NEW: 'n' },
    );
    expect(merged).toEqual({ PATH: '/b', TOKEN: 'old', WSLENV: 'kept', NEW: 'n' });
  });
});

describe('spawnSpec', () => {
  const cmd = { file: '/home/b/.local/bin/claude', args: ['-p', 'hi'], cwd: '/home/b/p' };

  it('local is identity (env handled by the caller)', () => {
    expect(spawnSpec(LOCAL_HOST, cmd, null)).toEqual({ file: cmd.file, args: cmd.args, cwd: cmd.cwd });
  });
  it('wsl wraps in wsl.exe -d --cd -e /usr/bin/env with sorted K=V', () => {
    const spec = spawnSpec(UB, { ...cmd, env: { B: '2', A: '1' } }, { PATH: '/bin', PWD: 'x' });
    expect(spec.file).toBe('wsl.exe');
    expect(spec.cwd).toBeNull();
    expect(spec.args).toEqual([
      '-d', 'Ubuntu-22.04', '--cd', '/home/b/p', '-e', '/usr/bin/env',
      'A=1', 'B=2', 'PATH=/bin',
      '/home/b/.local/bin/claude', '-p', 'hi',
    ]);
  });
  it('null shellEnv still sends cmd.env', () => {
    const spec = spawnSpec(UB, { ...cmd, env: { TOKEN: 't' } }, null);
    expect(spec.args).toContain('TOKEN=t');
  });
});

describe('ptySpec', () => {
  const cmd = { file: '/x/claude', args: ['-r', 'id'], cwd: '/p' };

  it('local is identity', () => {
    expect(ptySpec(LOCAL_HOST, cmd, '/bin/bash')).toEqual({ file: '/x/claude', args: ['-r', 'id'], cwd: '/p' });
  });
  it('wsl execs through an interactive login shell', () => {
    const spec = ptySpec(UB, { ...cmd, env: { K: 'v' } }, '/usr/bin/zsh');
    expect(spec).toEqual({
      file: 'wsl.exe',
      cwd: null,
      args: [
        '-d', 'Ubuntu-22.04', '--cd', '/p', '-e', '/usr/bin/zsh',
        '-ilc', 'exec "$0" "$@"', '/usr/bin/env', 'K=v', '/x/claude', '-r', 'id',
      ],
    });
  });
  it('falls back to /bin/bash and sorts env', () => {
    const spec = ptySpec(UB, { ...cmd, env: { Z: '1', A: '2' } }, null);
    expect(spec.args.indexOf('/bin/bash')).toBeGreaterThan(-1);
    const kv = spec.args.filter((a) => a.includes('=') && !a.startsWith('-'));
    expect(kv).toEqual(['A=2', 'Z=1']);
  });
});

describe('parseWslList', () => {
  it('parses the real wsl.exe -l -v shape', () => {
    const text =
      '  NAME            STATE           VERSION\n' +
      '* Ubuntu-22.04    Running         2\n' +
      '  wsl-vpnkit      Stopped         2\n' +
      '  Ubuntu-24.04    Running         2\n';
    expect(parseWslList(text)).toEqual([
      { name: 'Ubuntu-22.04', state: 'Running', default: true },
      { name: 'wsl-vpnkit', state: 'Stopped', default: false },
      { name: 'Ubuntu-24.04', state: 'Running', default: false },
    ]);
  });
  it('strips NUL and \\r and ignores non-state rows', () => {
    const text = '  NAME\x00  STATE   VERSION\r\n* D    Running   2\r\n  E    Installing   2\n';
    expect(parseWslList(text)).toEqual([{ name: 'D', state: 'Running', default: true }]);
  });
  it('empty input yields no rows', () => {
    expect(parseWslList('')).toEqual([]);
  });
});

describe('isWslHost / wslHost', () => {
  it('narrows wsl hosts and defaults mount to /mnt', () => {
    expect(isWslHost(UB)).toBe(true);
    expect(isWslHost(LOCAL_HOST)).toBe(false);
    expect(isWslHost(UB) && UB.mount).toBe('/mnt');
    expect(UB.id).toBe('wsl:Ubuntu-22.04');
  });
});

describe('isFsReady', () => {
  it('local is ready in any probe state, including none', () => {
    expect(isFsReady(LOCAL_HOST, 'ready')).toBe(true);
    expect(isFsReady(LOCAL_HOST, 'probing')).toBe(true);
    expect(isFsReady(LOCAL_HOST, 'error')).toBe(true);
    expect(isFsReady(LOCAL_HOST, undefined)).toBe(true);
    expect(isFsReady(LOCAL_HOST, null)).toBe(true);
  });
  it('wsl is ready only once the probe lands', () => {
    expect(isFsReady(UB, 'ready')).toBe(true);
    expect(isFsReady(UB, 'probing')).toBe(false);
    expect(isFsReady(UB, 'error')).toBe(false);
    expect(isFsReady(UB, 'stopped')).toBe(false);
    expect(isFsReady(UB, undefined)).toBe(false);
    expect(isFsReady(UB, null)).toBe(false);
  });
});

describe('shellFamily', () => {
  it('fish is its own family; everything else is posix', () => {
    expect(shellFamily('/usr/bin/fish')).toBe('fish');
    expect(shellFamily('fish')).toBe('fish');
    expect(shellFamily('/bin/bash')).toBe('posix');
    expect(shellFamily('zsh')).toBe('posix');
    expect(shellFamily(null)).toBe('posix');
  });
  it('fish ptys use exec $argv', () => {
    const spec = ptySpec(UB, { file: '/x', args: [], cwd: '/p' }, '/usr/bin/fish');
    expect(spec.args).toContain('exec $argv');
  });
});

describe('resolveLocalConfigDir', () => {
  const j = (...p: string[]) => p.join('/');
  it('prefers a trimmed, non-empty CLAUDE_CONFIG_DIR', () => {
    expect(resolveLocalConfigDir({ CLAUDE_CONFIG_DIR: '  D:/claude  ' }, '/home/u', j)).toBe('D:/claude');
  });
  it('falls back to <home>/.claude when unset or blank', () => {
    expect(resolveLocalConfigDir({}, '/home/u', j)).toBe('/home/u/.claude');
    expect(resolveLocalConfigDir({ CLAUDE_CONFIG_DIR: '   ' }, '/home/u', j)).toBe('/home/u/.claude');
  });
  it('is a snapshot — later env mutation does not change the captured value', () => {
    const env: { CLAUDE_CONFIG_DIR?: string } = { CLAUDE_CONFIG_DIR: 'C:/one' };
    const captured = resolveLocalConfigDir(env, '/home/u', j);
    env.CLAUDE_CONFIG_DIR = '//wsl.localhost/D/home/u/.claude';
    expect(captured).toBe('C:/one');
  });
});

describe('helperSpec', () => {
  const H = 'abcdef012345';
  const file = '/home/brian/.agent-workspace/helper-abcdef012345.mjs';
  it.each(['/bin/bash', '/usr/bin/zsh'])('posix shell %s is byte-exact', (shell) => {
    expect(helperSpec(UB, '/home/brian', shell, H)).toEqual({
      file: 'wsl.exe',
      cwd: null,
      args: [
        '-d', 'Ubuntu-22.04', '--cd', '/home/brian', '-e', shell,
        '-ilc', 'test -f "$0" || exit 86; exec node "$0" --stdio', file,
      ],
    });
  });
  it('fish uses $argv and still passes --stdio', () => {
    const spec = helperSpec(UB, '/home/brian', '/usr/bin/fish', H);
    expect(spec.args.slice(-2)).toEqual(['test -f $argv[1]; or exit 86; exec node $argv --stdio', file]);
  });
  it('the one-shot --apply-hooks-off mode reuses the launch line (exit 86 when missing)', () => {
    const spec = helperSpec(UB, '/home/brian', '/bin/bash', H, '--apply-hooks-off');
    expect(spec.args.slice(-2)).toEqual(['test -f "$0" || exit 86; exec node "$0" --apply-hooks-off', file]);
    const fish = helperSpec(UB, '/home/brian', '/usr/bin/fish', H, '--apply-hooks-off');
    expect(fish.args.slice(-2)).toEqual(['test -f $argv[1]; or exit 86; exec node $argv --apply-hooks-off', file]);
  });
  it('has no ~ and no UNC; a home with a space is one argv element', () => {
    const spec = helperSpec(wslHost('U', '/home/a b'), '/home/a b', '/bin/bash', H);
    expect(spec.args.join('')).not.toMatch(/~|\\\\/);
    expect(spec.args).toContain('/home/a b/.agent-workspace/helper-abcdef012345.mjs');
    expect(spec.args[3]).toBe('/home/a b');
  });
});

describe('helperDeploySpec', () => {
  it('passes the dir, file name and byte count as $1, $2 and $3', () => {
    const spec = helperDeploySpec(UB, '/home/brian/', 'abcdef012345', 123456);
    expect(spec.file).toBe('wsl.exe');
    expect(spec.args.slice(0, 5)).toEqual(['-d', 'Ubuntu-22.04', '-e', '/bin/sh', '-c']);
    expect(spec.args.slice(6)).toEqual(['sh', '/home/brian/.agent-workspace', 'helper-abcdef012345.mjs', '123456']);
  });
  it('only moves the tmp file into place when its size matches $3; a short stdin fails and leaves nothing', () => {
    const line = helperDeploySpec(UB, '/home/brian', 'abcdef012345', 10).args[5];
    expect(line).toBe(
      'mkdir -p "$1" && cat > "$1/.tmp.$$" && test "$(wc -c < "$1/.tmp.$$")" -eq "$3" && mv "$1/.tmp.$$" "$1/$2" || { rm -f "$1/.tmp.$$"; exit 1; }',
    );
  });
});

describe('helper probe', () => {
  it('probeLine only gains the presence check when a bundle exists', () => {
    expect(probeLine(null)).not.toContain('HELPER_PRESENT');
    expect(probeLine('abcdef012345')).toContain(
      'if test -f "$HOME/.agent-workspace/helper-abcdef012345.mjs"; then echo HELPER_PRESENT; fi',
    );
  });
  it('probeLine checks under the resolved (override) home — the same path deploy and launch use', () => {
    const line = probeLine('abcdef012345', '/srv/my home');
    expect(line).toContain(`if test -f '/srv/my home/.agent-workspace/helper-abcdef012345.mjs'; then echo HELPER_PRESENT; fi`);
    expect(line).not.toContain('"$HOME/.agent-workspace');
    // helperSpec / helperDeploySpec build their paths from the same home.
    const host = wslHost('D', '/srv/my home');
    expect(helperSpec(host, '/srv/my home', '/bin/bash', 'abcdef012345').args.at(-1)).toBe(
      '/srv/my home/.agent-workspace/helper-abcdef012345.mjs',
    );
    expect(helperDeploySpec(host, '/srv/my home', 'abcdef012345', 1).args.at(-3)).toBe('/srv/my home/.agent-workspace');
    expect(probeLine('abcdef012345', null)).toBe(probeLine('abcdef012345'));
  });
  it('posixQuote single-quotes and escapes embedded quotes', () => {
    expect(posixQuote('/home/u')).toBe(`'/home/u'`);
    expect(posixQuote(`/home/o'neil`)).toBe(`'/home/o'\\''neil'`);
  });
  it('sanitizeEnv keeps string values with valid keys and drops WSL-provided vars', () => {
    expect(
      sanitizeEnv({ PATH: '/usr/bin', WSL_INTEROP: '/run/x', 'ProgramFiles(x86)': 'C:\\', N: 1, HOME: '/home/u' }),
    ).toEqual({ PATH: '/usr/bin', HOME: '/home/u' });
    expect(sanitizeEnv(null)).toEqual({});
    expect(sanitizeEnv([1, 2])).toEqual({});
  });
  it('the presence token never becomes the shell', () => {
    expect(parseProbeOutput('/home/u\nu\nHELPER_PRESENT\n')).toEqual({ home: '/home/u', shell: undefined });
    expect(parseProbeOutput('/home/u\nu\n/bin/zsh\nHELPER_PRESENT\n')).toEqual({ home: '/home/u', shell: '/bin/zsh' });
    expect(parseHelperPresent('/home/u\nu\n/bin/zsh\nHELPER_PRESENT\n')).toBe(true);
    expect(parseHelperPresent('/home/u\nu\n/bin/zsh\n')).toBe(false);
  });
  it('deriveHelperState', () => {
    expect(deriveHelperState({ envOk: true, node: null, present: true })).toBe('node-missing');
    expect(deriveHelperState({ envOk: true, node: '16.20.0', present: true })).toBe('unsupported-node');
    expect(deriveHelperState({ envOk: true, node: '18.0.0', present: false })).toBe('absent');
    expect(deriveHelperState({ envOk: true, node: '22.12.0', present: true })).toBe('starting');
    expect(deriveHelperState({ envOk: false, node: null, present: false })).toBe('absent');
    expect(deriveHelperState({ envOk: false, node: null, present: true })).toBe('starting');
  });
});

describe('helper bundle info', () => {
  it('parseHelperHash accepts only 12 hex', () => {
    expect(parseHelperHash('{"hash":"abcdef012345"}')).toBe('abcdef012345');
    expect(parseHelperHash('{"hash":"xyz"}')).toBeNull();
    expect(parseHelperHash('nope')).toBeNull();
    expect(parseHelperHash(null)).toBeNull();
  });
  it('is unavailable without out/helper/helper-hash.json', () => {
    const out = mkdtempSync(join(tmpdir(), 'helper-out-'));
    expect(loadHelperBundleInfo(out)).toBeNull();
    mkdirSync(join(out, 'helper'));
    writeFileSync(join(out, 'helper', 'helper-hash.json'), '{"hash":"abcdef012345"}');
    expect(loadHelperBundleInfo(out)).toEqual({
      hash: 'abcdef012345',
      file: join(out, 'helper', 'agent-workspace-helper.mjs'),
    });
  });
});

// Models POSIX word splitting only (not fish); real-shell behaviour was verified separately against bash/sh/dash.
// Minimal POSIX-ish word splitter covering what sshQuote emits: '…' runs,
// "…" runs where only \\ is an escape, and adjacent concatenation.
function splitWords(line: string): string[] {
  const words: string[] = [];
  let cur: string | null = null;
  let i = 0;
  while (i < line.length) {
    const c = line[i]!;
    if (c === ' ') {
      if (cur !== null) words.push(cur);
      cur = null;
      i++;
    } else if (c === "'") {
      const end = line.indexOf("'", i + 1);
      cur = (cur ?? '') + line.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      let j = i + 1;
      let s = '';
      while (line[j] !== '"') {
        if (line[j] === '\\') j++;
        s += line[j++];
      }
      cur = (cur ?? '') + s;
      i = j + 1;
    } else if (c === '\\') {
      cur = (cur ?? '') + line[i + 1];
      i += 2;
    } else throw new Error(`unquoted char ${c} at ${i}`);
  }
  if (cur !== null) words.push(cur);
  return words;
}

const NASTY = [`a'b`, 'sp ace', '$HOME', '`id`', 'x\ny', '; rm -rf /', `'`, 'a\\b', 'trail\\', '"q"', '', '*', "\\'"];

describe('ssh host kind', () => {
  it('ssh:// path form round-trips', () => {
    expect(hostIdForPath('ssh://box/home/u/x')).toBe('ssh:box');
    expect(parseSshUri('ssh://box/home/u/x')).toEqual({ alias: 'box', path: '/home/u/x' });
    expect(parseSshUri('SSH://a.b_c-1/')).toEqual({ alias: 'a.b_c-1', path: '/' });
    const h = sshHost('box');
    expect(isSshHost(h)).toBe(true);
    expect(h.id).toBe('ssh:box');
    expect(toHostPath(h, 'ssh://box/home/u//x/')).toBe('/home/u/x');
    expect(toWindowsPath(h, '/home/u/x')).toBe('ssh://box/home/u/x');
    expect(toHostPath(h, toWindowsPath(h, '/home/u/x'))).toBe('/home/u/x');
    expect(displayPath(h, '/home/u/x', true)).toBe('box · /home/u/x');
    expect(displayPath(h, '/home/u/x', false)).toBe('/home/u/x');
    expect(workspaceLabel('ssh://box/home/u/x')).toBe('box · /home/u/x');
  });
  it('rejects invalid aliases', () => {
    for (const bad of ['', '-oProxyCommand=x', '-x', 'a b', 'a;b', 'a/b', 'a$b', 'a\nb', "a'b", 'a@b']) {
      expect(() => sshHost(bad)).toThrow();
      expect(() => sshSpawnSpec(bad, '/h', '/bin/sh', 'claude', [])).toThrow();
      expect(() => sshForwardSpec(bad, 4567)).toThrow();
      expect(() => sshHelperSpec(bad, '/h', '/bin/bash', 'abcdef012345')).toThrow();
      expect(() => sshHelperDeploySpec(bad, '/h', 'abcdef012345', 1)).toThrow();
      if (!bad.includes('/')) expect(hostIdForPath(`ssh://${bad}/x`)).toBe('local');
    }
  });
  it('posixQuote handles quotes, spaces, $, newlines', () => {
    expect(posixQuote(`a'b`)).toBe(`'a'\\''b'`);
    expect(posixQuote('a b')).toBe(`'a b'`);
    expect(posixQuote('$HOME')).toBe(`'$HOME'`);
    expect(posixQuote('x\ny')).toBe(`'x\ny'`);
  });
  it('sshQuote encodes backslashes as double-quoted "\\\\" (fish-safe) and only then differs from posixQuote', () => {
    expect(sshQuote('a\\')).toBe(`'a'"\\\\"''`);
    expect(sshQuote('\\')).toBe(`''"\\\\"''`);
    expect(sshQuote('a\\b')).toBe(`'a'"\\\\"'b'`);
    for (const s of ['', 'a', 'a b', `a'b`, '$x', 'a\\', '\\', 'a\\b', 'x\ny']) {
      expect(sshQuote(s) !== posixQuote(s)).toBe(s.includes('\\'));
    }
  });
  it('sshQuote round-trips the Phase 8 argument set as single words', () => {
    const phase8 = [
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'http://127.0.0.1:1/hook/PreToolUse' }] }] } }),
      'two words',
      'a"q',
      '50%',
      'trail\\',
      '$HOME',
      'unicode é',
    ];
    expect(splitWords(phase8.map(sshQuote).join(' '))).toEqual(phase8);
  });
  it('sshQuote round-trips a nasty argument set as single words', () => {
    expect(splitWords(NASTY.map(sshQuote).join(' '))).toEqual(NASTY);
    for (const s of ['a b', '$x', `a'b`]) expect(sshQuote(s)).toBe(posixQuote(s));
  });
  const BASE = ['-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', '-o', 'ConnectTimeout=10'];
  it('sshSpawnSpec (fix round 1 #4): login shell via /bin/sh, env only on stdin — never in argv', () => {
    const spec = sshSpawnSpec('box', '/home/u/my proj', '/bin/zsh', 'claude', ['-p', '$(id)', 'x;y', "o'k"]);
    expect(spec.file).toBe('ssh.exe');
    expect(spec.cwd).toBeNull();
    expect(spec.args.slice(0, 9)).toEqual([...BASE, '-T', 'box', '--']);
    expect(spec.args).toHaveLength(10);
    expect(spec.args[9]!.startsWith('exec ')).toBe(true);
    const words = splitWords(spec.args[9]!.slice(5));
    expect(words.slice(0, 2)).toEqual(['/bin/sh', '-c']);
    expect(words[2]).toBe(SSH_RUN_STDIN_SCRIPT);
    expect(words.slice(3)).toEqual(['exec "$0" "$@"', '/home/u/my proj', '/bin/zsh', 'claude', '-p', '$(id)', 'x;y', "o'k"]);
    expect(splitWords(sshSpawnSpec('box', '/h', '/usr/bin/fish', 'c', []).args[9]!.slice(5))[3]).toBe('exec $argv');
  });
  it('sshEnvLine: base64 of `export K=V` lines; values never appear in clear', () => {
    const env = { TOKEN: 's3cr3t-value', B: "it's $(x)" };
    const line = sshEnvLine(env);
    expect(line.endsWith('\n')).toBe(true);
    expect(line).not.toContain('s3cr3t-value');
    expect(Buffer.from(line.trim(), 'base64').toString('utf8')).toBe(sshEnvFileContent(env));
    expect(sshEnvFileContent(env)).toBe(`export B='it'\\''s $(x)'\nexport TOKEN='s3cr3t-value'\n`);
    expect(sshEnvLine({})).toBe('\n');
    expect(() => sshEnvFileContent({ 'A;B': '1' })).toThrow();
  });
  // The remote half of the scripts, run by a real POSIX sh when one is on PATH
  // (Git Bash on Windows runners/dev boxes; skipped otherwise).
  const hasSh = spawnSync('sh', ['-c', 'command -v base64 >/dev/null'], { windowsHide: true }).status === 0;
  it.skipIf(!hasSh)('SSH_RUN_STDIN_SCRIPT: real sh reads the env line, leaves the rest of stdin to the CLI', () => {
    const env = { TOKEN: 's3cr3t', B: "it's $(x) \\ \"q\"" };
    const r = spawnSync(
      'sh',
      ['-c', SSH_RUN_STDIN_SCRIPT, 'exec "$0" "$@"', '/', 'sh', 'sh', '-c', 'printf "%s|%s|" "$TOKEN" "$B"; cat'],
      { input: `${sshEnvLine(env)}rest-of-stdin\n`, encoding: 'utf8', windowsHide: true },
    );
    expect(r.stdout.endsWith(`s3cr3t|it's $(x) \\ "q"|rest-of-stdin\n`)).toBe(true);
  });
  it.skipIf(!hasSh)('SSH_RUN_FILE_SCRIPT: real sh sources then deletes the staged file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssh-run-file-'));
    const file = join(dir, 'env').replace(/\\/g, '/');
    writeFileSync(file, sshEnvFileContent({ TOKEN: 'tok value' }));
    const r = spawnSync('sh', ['-c', SSH_RUN_FILE_SCRIPT, 'exec "$0" "$@"', file, '/', 'sh', 'sh', '-c', 'printf "%s" "$TOKEN"'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(r.stdout.endsWith('tok value')).toBe(true);
    expect(existsSync(join(dir, 'env'))).toBe(false);
  });
  it('sshSpawnSpec rejects relative cwd/shell and option-like commands', () => {
    expect(() => sshSpawnSpec('box', 'rel', '/bin/sh', 'claude', [])).toThrow();
    expect(() => sshSpawnSpec('box', '/h', 'bash', 'claude', [])).toThrow();
    expect(() => sshSpawnSpec('box', '/h', '/bin/sh', '-oFoo', [])).toThrow();
  });
  it('sshPtySpec forces a tty; the token travels in a staged file, only its path is in argv', () => {
    const file = '/home/u/.agent-workspace/run/0123456789abcdef0123456789abcdef';
    const spec = sshPtySpec('box', '/home/u', file, '/usr/bin/claude', ['-r', 'id'], '/bin/zsh');
    expect(spec.args.slice(0, 9)).toEqual([...BASE, '-t', 'box', '--']);
    const words = splitWords(spec.args[9]!.slice(5));
    expect(words.slice(0, 2)).toEqual(['/bin/sh', '-c']);
    expect(words[2]).toBe(SSH_RUN_FILE_SCRIPT);
    expect(words.slice(3)).toEqual(['exec "$0" "$@"', file, '/home/u', '/bin/zsh', '/usr/bin/claude', '-r', 'id']);
    expect(splitWords(sshPtySpec('box', '/h', null, 'c', [], '/usr/bin/fish').args[9]!.slice(5)).slice(3, 5)).toEqual([
      'exec $argv',
      '',
    ]);
    expect(() => sshPtySpec('box', '/h', 'relative', 'c', [], '/bin/sh')).toThrow();
  });
  it('sshHelperSpec mirrors the wsl launch line (exit 86 when missing) and never carries -R', () => {
    const spec = sshHelperSpec('box', '/home/u', '/bin/bash', 'abcdef012345');
    expect(spec.args).toEqual([
      ...BASE, '-T', 'box', '--',
      `cd '/home/u' && exec '/bin/bash' -ilc 'test -f "$0" || exit 86; exec node "$0" --stdio' '/home/u/.agent-workspace/helper-abcdef012345.mjs'`,
    ]);
    expect(sshHelperSpec('box', '/h', '/usr/bin/fish', 'abcdef012345').args.at(-1)).toContain(
      `'test -f $argv[1]; or exit 86; exec node $argv --stdio'`,
    );
  });
  it('sshForwardSpec: its own -N connection, loopback-bound -R, fails closed', () => {
    expect(sshForwardSpec('box', 4567)).toEqual({
      file: 'ssh.exe',
      args: [...BASE, '-o', 'ExitOnForwardFailure=yes', '-N', '-T', '-R', '127.0.0.1:4567:127.0.0.1:4567', 'box'],
      cwd: null,
    });
    expect(() => sshForwardSpec('box', 0)).toThrow();
    expect(() => sshForwardSpec('box', 70000)).toThrow();
  });
  it('sshFailureClass / sshRecoveryDue: only connection failures recover, throttled to 1/min', () => {
    expect(sshFailureClass({ code: 255, timedOut: false })).toBe('connection');
    expect(sshFailureClass({ code: null, timedOut: true })).toBe('connection');
    expect(sshFailureClass({ code: 1, timedOut: false })).toBe('other');
    expect(sshFailureClass({ code: 86, timedOut: false })).toBe('other');
    expect(sshRecoveryDue(null, 1_000)).toBe(true);
    expect(sshRecoveryDue(1_000, 30_000)).toBe(false);
    expect(sshRecoveryDue(1_000, 61_000)).toBe(true);
  });
  it('sshHelperDeploySpec runs the same byte-gated atomic script', () => {
    const wsl = helperDeploySpec(UB, '/home/u', 'abcdef012345', 10).args[5]!;
    const spec = sshHelperDeploySpec('box', '/home/u', 'abcdef012345', 10);
    const remote = spec.args.at(-1)!;
    expect(remote).toBe(
      `exec '/bin/sh' '-c' '${wsl}' 'sh' '/home/u/.agent-workspace' 'helper-abcdef012345.mjs' '10'`,
    );
    expect(splitWords(remote.slice('exec '.length))[2]).toBe(wsl);
  });
});

describe('ssh host kind — P3 canonical alias, path normalisation, probe specs', () => {
  it('canonical alias is trimmed + lower-cased; invalid input is null', () => {
    expect(canonicalSshAlias('  Box.Example ')).toBe('box.example');
    for (const bad of ['', ' ', '-x', 'a b', 'a/b', 'ssh://box', 'a;b', 'x'.repeat(129)]) {
      expect(canonicalSshAlias(bad), bad).toBeNull();
    }
  });
  it('the alias in ids and ssh:// paths is canonical (lower case)', () => {
    expect(hostIdForPath('ssh://Box/home/u')).toBe('ssh:box');
    expect(parseSshUri('ssh://BOX/a')).toEqual({ alias: 'box', path: '/a' });
    expect(sshHost('Box').id).toBe('ssh:box');
    expect(toHostPath(sshHost('box'), 'ssh://BOX/a/')).toBe('/a');
  });
  it('normalizeSshPath canonicalises and rejects malformed ssh paths', () => {
    expect(normalizeSshPath('ssh://Box//home/u/')).toBe('ssh://box/home/u');
    expect(normalizeSshPath('SSH://box')).toBe('ssh://box/');
    for (const bad of ['ssh://-x/a', 'ssh:box/a', 'ssh:///a', 'ssh://a b/x', 'ssh://box\\x']) {
      expect(isSshPathLike(bad), bad).toBe(true);
      expect(normalizeSshPath(bad), bad).toBeNull();
    }
    expect(isSshPathLike('C:\\ssh\\x')).toBe(false);
    expect(isSshPathLike('\\\\wsl.localhost\\U\\x')).toBe(false);
  });
  it('normalizeWorkspacePath: ssh paths canonical, malformed ones rejected, others resolved', () => {
    const resolveLocal = (p: string) => `R(${p})`;
    expect(normalizeWorkspacePath('ssh://Box/home/u/', resolveLocal)).toBe('ssh://box/home/u');
    expect(normalizeWorkspacePath('C:\\work', resolveLocal)).toBe('R(C:\\work)');
    expect(() => normalizeWorkspacePath('ssh:box/x', resolveLocal)).toThrow(INVALID_SSH_PATH_MESSAGE);
    expect(() => normalizeWorkspacePath('ssh://-o/x', resolveLocal)).toThrow(INVALID_SSH_PATH_MESSAGE);
  });
  it('isRemoteHost: wsl and ssh, never local', () => {
    expect(isRemoteHost(LOCAL_HOST)).toBe(false);
    expect(isRemoteHost(wslHost('U', null))).toBe(true);
    expect(isRemoteHost(sshHost('box'))).toBe(true);
  });
  it('sshCommandSpec quotes every argv word behind exec', () => {
    const spec = sshCommandSpec('box', ['curl', '-w', '%{http_code}', 'http://127.0.0.1:1/x y']);
    expect(spec.file).toBe('ssh.exe');
    expect(spec.args.slice(0, 9)).toEqual(['-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', '-o', 'ConnectTimeout=10', '-T', 'box', '--']);
    expect(spec.args[9]).toBe(`exec 'curl' '-w' '%{http_code}' 'http://127.0.0.1:1/x y'`);
    expect(splitWords(spec.args[9]!.slice('exec '.length))).toEqual([
      'curl',
      '-w',
      '%{http_code}',
      'http://127.0.0.1:1/x y',
    ]);
  });
  it('sshProbeSpec runs the wsl probe line under /bin/sh (any login shell)', () => {
    const spec = sshProbeSpec('box', 'abcdef012345', null);
    const words = splitWords(spec.args.at(-1)!.slice('exec '.length));
    expect(words).toEqual(['/bin/sh', '-c', probeLine('abcdef012345', null)]);
    expect(splitWords(sshProbeSpec('box', null, '/srv/h').args.at(-1)!.slice('exec '.length))[2]).toBe(
      probeLine(null, '/srv/h'),
    );
  });
  it('sshEnvSpec + parseSshEnvProbe: env, node and CLI paths from one login-shell run', () => {
    const spec = sshEnvSpec('box', '/bin/zsh');
    const remote = spec.args.at(-1)!;
    expect(remote.startsWith(`exec '/bin/zsh' -ilc `)).toBe(true);
    const cmd = splitWords(remote.slice(`exec '/bin/zsh' -ilc `.length))[0]!;
    expect(cmd).toContain('__DW_ENV__');
    expect(cmd).toContain('__DW_NODE__');
    expect(cmd).toContain('__DW_CLI__');
    const out =
      'motd junk\n\0__DW_ENV__\0HOME=/home/u\0PATH=/usr/bin\0\0__DW_NODE__\0/usr/bin/node\n20.11.1\n' +
      '\0__DW_CLI__\0claude=/home/u/.local/bin/claude\ndevin=\ngh=/usr/bin/gh\nversion=2.1.296 (Claude Code)\n';
    expect(parseSshEnvProbe(out)).toEqual({
      env: { HOME: '/home/u', PATH: '/usr/bin' },
      node: '20.11.1',
      claude: '/home/u/.local/bin/claude',
      devin: null,
      gh: true,
      version: '2.1.296',
    });
    expect(parseSshEnvProbe('nothing')).toEqual({
      env: null,
      node: null,
      claude: null,
      devin: null,
      gh: false,
      version: null,
    });
  });
});
