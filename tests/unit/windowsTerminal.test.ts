import { describe, expect, it } from 'vitest';
import {
  expandEnvVars,
  parseJsonc,
  readProfiles,
  resolveProfileCommand,
  settingsCandidates,
  splitCommandline,
  type ResolveCtx,
  type WtProfile,
  wtDistroList,
} from '../../src/core/windowsTerminal';

// Shape mirrors a real settings.json (comments + trailing commas included).
const FIXTURE = `{
  // WT writes JSONC.
  "$schema": "https://aka.ms/terminal-profiles-schema",
  "defaultProfile": "{4ff56d04-1111-2222-3333-444455556666}",
  "profiles": {
    "defaults": { "font": { "face": "Cascadia Mono" }, },
    "list": [
      {
        "guid": "{4ff56d04-1111-2222-3333-444455556666}",
        "name": "Ubuntu 22.04.5 LTS",
        "source": "CanonicalGroupLimited.Ubuntu22.04LTS_79rhkp1fndgsc",
      },
      {
        "guid": "{61c54bbd-aaaa-bbbb-cccc-ddddeeeeffff}",
        "name": "Windows PowerShell",
        "commandline": "%SystemRoot%\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe",
      },
      {
        "guid": "{0caa0dad-cccc-dddd-eeee-ffff00001111}",
        "name": "Command Prompt",
        "commandline": "%SystemRoot%\\\\System32\\\\cmd.exe",
      },
      {
        "guid": "{b453ae62-dddd-eeee-ffff-000011112222}",
        "name": "Azure Cloud Shell",
        "source": "Windows.Terminal.Azure",
      },
      {
        "guid": "{dev-vs-prompt}",
        "name": "Developer Command Prompt",
        "source": "Windows.Terminal.VisualStudio",
      },
      {
        "guid": "{wsl-ubuntu}",
        "name": "Ubuntu",
        "source": "Microsoft.WSL",
      },
      {
        "guid": "{wsl-vpnkit}",
        "name": "wsl-vpnkit",
        "source": "Windows.Terminal.Wsl",
        "commandline": "C:\\\\WINDOWS\\\\system32\\\\wsl.exe -d wsl-vpnkit --cd /app wsl-vpnkit",
      },
      {
        "guid": "{hidden-one}",
        "name": "Hidden",
        "hidden": true,
      },
    ],
  },
}`;

const DISTROS = ['Ubuntu-22.04', 'Ubuntu', 'Ubuntu-24.04', 'wsl-vpnkit'];
const ENV = {
  SystemRoot: 'C:\\Windows',
  ProgramFiles: 'C:\\Program Files',
};
const ctx = (over: Partial<ResolveCtx> = {}): ResolveCtx => ({
  env: ENV,
  distros: DISTROS,
  pwshPath: null,
  windowsAppsDir: null,
  existsSync: () => false,
  ...over,
});

const byName = (name: string): WtProfile => {
  const { profiles } = readProfiles(parseJsonc(FIXTURE));
  const found = profiles.find((p) => p.name === name);
  if (!found) throw new Error(`fixture profile ${name}`);
  return found;
};

describe('parseJsonc', () => {
  it('strips comments and trailing commas', () => {
    const parsed = parseJsonc('{ "a": 1, /* block */ "b": [2,], } // tail') as any;
    expect(parsed).toEqual({ a: 1, b: [2] });
  });
  it('does not strip // inside strings', () => {
    expect(parseJsonc('{"u": "https://x//y"}' as string)).toEqual({ u: 'https://x//y' });
  });
});

describe('readProfiles', () => {
  it('reads defaultProfile and skips hidden entries', () => {
    const file = readProfiles(parseJsonc(FIXTURE));
    expect(file.defaultProfile).toBe('{4ff56d04-1111-2222-3333-444455556666}');
    expect(file.profiles.map((p) => p.name)).not.toContain('Hidden');
  });
  it('accepts a bare-array profiles field (older files)', () => {
    const file = readProfiles({ defaultProfile: null, profiles: [{ guid: 'g', name: 'n' }] });
    expect(file.profiles).toHaveLength(1);
  });
});

describe('resolveProfileCommand', () => {
  it('resolves the default distro profile via a fuzzy distro match', () => {
    const resolved = resolveProfileCommand(byName('Ubuntu 22.04.5 LTS'), ctx());
    expect(resolved).toEqual({ file: 'wsl.exe', args: ['-d', 'Ubuntu-22.04'], label: 'Ubuntu 22.04.5 LTS' });
  });
  it('expands %SystemRoot% in explicit commandlines', () => {
    expect(resolveProfileCommand(byName('Windows PowerShell'), ctx())?.file).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    );
    expect(resolveProfileCommand(byName('Command Prompt'), ctx())?.file).toBe('C:\\Windows\\System32\\cmd.exe');
  });
  it('splits quoted commandlines', () => {
    const p: WtProfile = { guid: 'g', name: 'n', commandline: '"C:\\Program Files\\Tool\\x.exe" -a "two words"', hidden: false };
    expect(resolveProfileCommand(p, ctx())).toEqual({
      file: 'C:\\Program Files\\Tool\\x.exe',
      args: ['-a', 'two words'],
      label: 'n',
    });
  });
  it('maps PowershellCore to pwsh when present, else null', () => {
    const p: WtProfile = { guid: 'g', name: 'pwsh', source: 'Windows.Terminal.PowershellCore', hidden: false };
    expect(resolveProfileCommand(p, ctx({ pwshPath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' }))?.file).toContain('pwsh.exe');
    expect(resolveProfileCommand(p, ctx({ pwshPath: null }))).toBeNull();
  });
  it('returns null for Azure/VS profiles without a commandline', () => {
    expect(resolveProfileCommand(byName('Azure Cloud Shell'), ctx())).toBeNull();
    expect(resolveProfileCommand(byName('Developer Command Prompt'), ctx())).toBeNull();
  });
  it('returns null for a distro name with no matching distro', () => {
    const p: WtProfile = { guid: 'g', name: 'Gentoo', source: 'Microsoft.WSL', hidden: false };
    expect(resolveProfileCommand(p, ctx())).toBeNull();
  });
  it('keeps an explicit commandline even for a Wsl-sourced profile', () => {
    const resolved = resolveProfileCommand(byName('wsl-vpnkit'), ctx());
    expect(resolved?.args).toEqual(['-d', 'wsl-vpnkit', '--cd', '/app', 'wsl-vpnkit']);
  });
});

describe('helpers', () => {
  it('expands env vars case-insensitively, keeps unknown ones', () => {
    expect(expandEnvVars('%SYSTEMROOT%\\x %NOPE%', ENV)).toBe('C:\\Windows\\x %NOPE%');
  });
  it('splitCommandline handles bare and quoted tokens', () => {
    expect(splitCommandline('cmd.exe /k "a b"')).toEqual(['cmd.exe', '/k', 'a b']);
  });
  it('settingsCandidates lists the three known locations', () => {
    expect(settingsCandidates('L').filter((p) => p.endsWith('settings.json'))).toHaveLength(3);
  });
});

// R28: WSL profile matching after P2 — the installed-distro list comes from
// the hosts enumeration (WSL enabled) or one lazy `wsl -l -q` (disabled);
// while neither is known, WSL profiles stay embeddable.
describe('wtDistroList', () => {
  it('WSL enabled: the enumeration names once it has completed', () => {
    expect(wtDistroList({ wslEnabled: true, enumCompleted: true, enumNames: ['Ubuntu'], lazyNames: null })).toEqual({
      distros: ['Ubuntu'],
      needLazyList: false,
    });
  });

  it('WSL enabled, enumeration not completed yet: unknown, no extra list', () => {
    expect(wtDistroList({ wslEnabled: true, enumCompleted: false, enumNames: [], lazyNames: null })).toEqual({
      distros: null,
      needLazyList: false,
    });
  });

  it('WSL disabled: needs the lazy list until it lands, then uses it', () => {
    // The enumeration answers [] while WSL is disabled — never used.
    expect(wtDistroList({ wslEnabled: false, enumCompleted: true, enumNames: [], lazyNames: null })).toEqual({
      distros: null,
      needLazyList: true,
    });
    expect(wtDistroList({ wslEnabled: false, enumCompleted: true, enumNames: [], lazyNames: ['Ubuntu-22.04'] })).toEqual({
      distros: ['Ubuntu-22.04'],
      needLazyList: false,
    });
  });
});

describe('resolveProfileCommand with an unknown distro list', () => {
  it('keeps a WSL profile embeddable (wsl.exe -d <profile name>)', () => {
    expect(resolveProfileCommand(byName('Ubuntu 22.04.5 LTS'), ctx({ distros: null }))).toEqual({
      file: 'wsl.exe',
      args: ['-d', 'Ubuntu 22.04.5 LTS'],
      label: 'Ubuntu 22.04.5 LTS',
    });
  });

  it('an empty known list still makes it unavailable', () => {
    expect(resolveProfileCommand(byName('Ubuntu 22.04.5 LTS'), ctx({ distros: [] }))).toBeNull();
  });
});
