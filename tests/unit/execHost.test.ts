import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadHelperBundleInfo } from '../../src/main/helperBundle';
import {
  deriveHelperState,
  displayPath,
  helperDeploySpec,
  helperSpec,
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
  it('has no ~ and no UNC; a home with a space is one argv element', () => {
    const spec = helperSpec(wslHost('U', '/home/a b'), '/home/a b', '/bin/bash', H);
    expect(spec.args.join('')).not.toMatch(/~|\\\\/);
    expect(spec.args).toContain('/home/a b/.agent-workspace/helper-abcdef012345.mjs');
    expect(spec.args[3]).toBe('/home/a b');
  });
});

describe('helperDeploySpec', () => {
  it('passes the dir and file name as $1 and $2', () => {
    const spec = helperDeploySpec(UB, '/home/brian/', 'abcdef012345');
    expect(spec.file).toBe('wsl.exe');
    expect(spec.args.slice(0, 5)).toEqual(['-d', 'Ubuntu-22.04', '-e', '/bin/sh', '-c']);
    expect(spec.args[5]).toBe('mkdir -p "$1" && cat > "$1/.tmp.$$" && mv "$1/.tmp.$$" "$1/$2"');
    expect(spec.args.slice(6)).toEqual(['sh', '/home/brian/.agent-workspace', 'helper-abcdef012345.mjs']);
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
    expect(helperDeploySpec(host, '/srv/my home', 'abcdef012345').args.at(-2)).toBe('/srv/my home/.agent-workspace');
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
