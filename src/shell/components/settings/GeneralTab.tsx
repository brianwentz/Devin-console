import { useState } from 'react';
import { updateDraft, useSettingsDraft } from '../../settingsDraft';
import { useShellState } from '../../store';
import { FieldError, fieldInputClass } from './fields';
import { inputClass } from './styles';

const HELPER_LABELS: Record<string, string> = {
  absent: 'not deployed',
  starting: 'starting',
  ready: 'ready',
  reconnecting: 'reconnecting',
  degraded: 'stopped after repeated failures — use Re-check',
  'node-missing': 'needs Node',
  'unsupported-node': 'needs a newer Node',
};
const helperLabel = (state: string): string => HELPER_LABELS[state] ?? state;

// P3 — "Add SSH host…": the alias is a Host from ~/.ssh/config; main
// validates and lower-cases it (OpenSSH matches Host names case-insensitively).
function SshHostAdd() {
  const [open, setOpen] = useState(false);
  const [alias, setAlias] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    const result = await window.agentworkspace.hostsSshAdd(alias);
    if (result.ok) {
      setAlias('');
      setError(null);
      setOpen(false);
    } else setError(result.error);
  };
  if (!open) {
    return (
      <button
        id="sshHostAdd"
        type="button"
        className="self-start text-xs text-[#6e9bd0]"
        onClick={() => setOpen(true)}
      >
        Add SSH host…
      </button>
    );
  }
  return (
    <div className="flex flex-col gap-1 text-sm">
      <div className="flex items-center gap-2">
        <input
          id="sshHostAliasInput"
          className={inputClass}
          value={alias}
          autoFocus
          spellCheck={false}
          placeholder="Host alias from ~/.ssh/config"
          aria-invalid={error ? 'true' : undefined}
          onChange={(event) => setAlias(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void add();
            if (event.key === 'Escape') setOpen(false);
          }}
        />
        <button id="sshHostAddConfirm" type="button" className="text-xs text-[#6e9bd0]" onClick={() => void add()}>
          Add
        </button>
        <button type="button" className="text-xs text-[#7f8ca0]" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      <FieldError inputId="sshHostAliasInput" message={error ?? undefined} />
      <span className="text-xs text-[#7f8ca0]">
        Connects with <code>ssh -o BatchMode=yes</code>: key or agent authentication only, and the host key must
        already be known (connect once in a terminal first). The host needs Node 18 or newer.
      </span>
    </div>
  );
}

function HostsBlock() {
  const state = useShellState();
  const { draft } = useSettingsDraft();
  const [openOverrides, setOpenOverrides] = useState<string | null>(null);
  if (!state || !draft) return null;
  const hosts = state.hosts ?? [];
  const overrides = state.settings.hosts?.overrides ?? {};

  const facts = (host: (typeof hosts)[number]): string => {
    const claude = host.claude.path
      ? `Claude Code ${host.claude.version ?? 'found'}`
      : 'Claude Code not found';
    const devin = host.devin.path ? 'devin found' : 'devin not found';
    const env = host.shellEnv
      ? host.shellEnv.ok
        ? `shell env ${host.shellEnv.count} vars`
        : 'shell env unavailable'
      : 'shell env —';
    return `${claude} · ${devin} · ${env} · hooks ${host.hooks}`;
  };

  const patchOverride = (
    id: string,
    patch: Partial<{
      claudePath: string | null;
      devinPath: string | null;
      home: string | null;
      shell: string | null;
      envCaptureDisabled: boolean;
    }>,
  ): void => {
    void window.agentworkspace.commitSettings({
      hosts: { overrides: { [id]: patch } },
    });
  };

  const overrideField = (
    host: (typeof hosts)[number],
    field: 'claudePath' | 'devinPath' | 'home' | 'shell',
    label: string,
  ) => {
    const value = (overrides[host.id]?.[field] as string | null | undefined) ?? '';
    return (
      <label className="flex flex-col gap-1 text-xs" key={field}>
        <span className="text-[#7f8ca0]">{label}</span>
        <input
          className={inputClass}
          defaultValue={value}
          data-host-override={field}
          placeholder={field === 'shell' ? 'e.g. /bin/zsh' : ''}
          onBlur={(event) => {
            const next = event.target.value.trim();
            if (next !== value.trim()) patchOverride(host.id, { [field]: next || null });
          }}
        />
      </label>
    );
  };

  return (
    <div id="hostsBlock" className="flex flex-col gap-2">
      <span className="text-sm text-[#aeb9c8]">Hosts</span>
      {hosts.map((host) => (
        <div key={host.id} data-host-id={host.id} className="flex flex-col gap-1 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-[#dfe6ef]">
              {host.kind === 'ssh' ? `SSH: ${host.label}` : host.label}
            </span>
            <span data-host-state className="text-xs text-[#7f8ca0]">
              {host.state}
            </span>
            {(host.kind === 'wsl' || host.kind === 'ssh') && (
              <label className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  data-host-enabled
                  checked={host.state !== 'disabled' && (host.kind === 'ssh' || host.state !== 'stopped')}
                  onChange={(event) => {
                    void window.agentworkspace.hostsSetEnabled(
                      host.id,
                      event.target.checked,
                    );
                  }}
                />
                <span>enabled</span>
              </label>
            )}
            <button
              type="button"
              className="text-xs text-[#6e9bd0]"
              data-host-recheck
              onClick={() => void window.agentworkspace.hostsRefresh(host.id)}
            >
              Re-check
            </button>
            <button
              type="button"
              className="text-xs text-[#6e9bd0]"
              data-host-overrides-toggle
              onClick={() => setOpenOverrides(openOverrides === host.id ? null : host.id)}
            >
              Overrides
            </button>
            {host.kind === 'ssh' && (
              <button
                type="button"
                className="text-xs text-[#d08080]"
                data-host-remove
                onClick={() => void window.agentworkspace.hostsSshRemove(host.id)}
              >
                Remove
              </button>
            )}
          </div>
          <span data-host-facts className="text-xs text-[#7f8ca0]">
            {facts(host)}
          </span>
          {state.claude.hostErrors?.[host.id] && (
            <span data-host-error className="text-xs text-[#e0a03c]">
              {state.claude.hostErrors[host.id]}
            </span>
          )}
          {host.helper ? (
            <span data-host-helper={host.helper.state} className="text-xs text-[#7f8ca0]">
              {host.state === 'stopped'
                ? 'helper paused (distro stopped)'
                : `helper ${helperLabel(host.helper.state)}`}
            </span>
          ) : null}
          {host.helper?.state === 'node-missing' || host.helper?.state === 'unsupported-node' ? (
            <span id={`hostHelperHint-${host.id}`} className="text-xs text-[#d0a060]">
              {host.helper.state === 'unsupported-node' && host.node
                ? `Node 18 or newer is required ${host.kind === 'ssh' ? 'on this host' : 'in this distro'} for the Agent Workspace helper (found ${host.node}).`
                : `Node 18 or newer is required ${host.kind === 'ssh' ? 'on this host' : 'in this distro'} for the Agent Workspace helper.`}
            </span>
          ) : null}
          {host.kind === 'ssh' && /\/t?csh$/.test(host.shell ?? '') ? (
            <span id={`sshShellHint-${host.id}`} className="text-xs text-[#d0a060]">
              csh/tcsh login shells are not supported for SSH hosts — set Overrides → Shell to bash, zsh, sh or fish.
            </span>
          ) : null}
          {host.error ? (
            <span className="text-xs text-[#d08080]">{host.error}</span>
          ) : null}
          {openOverrides === host.id ? (
            <div data-host-overrides className="flex flex-col gap-2 border-l border-[#2c3949] pl-3">
              {overrideField(host, 'claudePath', 'Claude path')}
              {overrideField(host, 'devinPath', 'devin path')}
              {overrideField(host, 'home', 'Home directory')}
              {overrideField(host, 'shell', 'Shell')}
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  data-host-override="envCaptureDisabled"
                  checked={overrides[host.id]?.envCaptureDisabled ?? false}
                  onChange={(event) =>
                    patchOverride(host.id, { envCaptureDisabled: event.target.checked })
                  }
                />
                <span>Skip shell environment capture</span>
              </label>
            </div>
          ) : null}
        </div>
      ))}
      <SshHostAdd />
    </div>
  );
}

export function GeneralTab() {
  const { draft, errors } = useSettingsDraft();
  if (!draft) return null;

  return (
    <div className="flex flex-col gap-5">
      <span className="text-sm text-[#aeb9c8]">Linked Context</span>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[#aeb9c8]">
          Keep hidden GitHub tabs live for (hours, 0 = discard on switch)
        </span>
        <input
          id="keepAliveInput"
          className={fieldInputClass(errors, 'keepAliveHours')}
          type="number"
          min={0}
          max={168}
          step={1}
          value={draft.keepAliveHours}
          aria-invalid={errors.keepAliveHours ? 'true' : undefined}
          onChange={(event) => updateDraft({ keepAliveHours: event.target.value })}
        />
        <FieldError inputId="keepAliveInput" message={errors.keepAliveHours} />
        <span className="text-xs text-[#7f8ca0]">
          Tabs from other sessions stay live for this long; beyond it they reload on activation.
        </span>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[#aeb9c8]">Max live tabs</span>
        <input
          id="maxLiveTabsInput"
          className={fieldInputClass(errors, 'maxLiveTabs')}
          type="number"
          min={1}
          max={40}
          step={1}
          value={draft.maxLiveTabs}
          aria-invalid={errors.maxLiveTabs ? 'true' : undefined}
          onChange={(event) => updateDraft({ maxLiveTabs: event.target.value })}
        />
        <FieldError inputId="maxLiveTabsInput" message={errors.maxLiveTabs} />
        <span className="text-xs text-[#7f8ca0]">
          Hard cap on live GitHub pages across all sessions (≈400 MB each); the tab you're looking
          at is exempt.
        </span>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[#aeb9c8]">Check Devin Cloud usage every (minutes)</span>
        <input
          id="usageDevinPollMinutes"
          className={fieldInputClass(errors, 'usageDevinPollMinutes')}
          type="number"
          min={5}
          max={240}
          step={1}
          value={draft.usageDevinPollMinutes}
          aria-invalid={errors.usageDevinPollMinutes ? 'true' : undefined}
          onChange={(event) => updateDraft({ usageDevinPollMinutes: event.target.value })}
        />
        <FieldError inputId="usageDevinPollMinutes" message={errors.usageDevinPollMinutes} />
        <span className="text-xs text-[#7f8ca0]">
          How often the app polls your monthly ACU usage for alerts (50% / 80%).
        </span>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          id="sessionsColumnToggle"
          type="checkbox"
          checked={draft.sessionsOpen}
          onChange={(event) => updateDraft({ sessionsOpen: event.target.checked })}
        />
        <span>Show the sessions column (Cloud, Devin Local and Claude)</span>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[#aeb9c8]">Shell command</span>
        <input
          id="terminalShellInput"
          className={fieldInputClass(errors, 'terminalShell')}
          value={draft.terminalShell}
          aria-invalid={errors.terminalShell ? 'true' : undefined}
          onChange={(event) => updateDraft({ terminalShell: event.target.value })}
          placeholder={
            window.agentworkspace.platform === 'darwin'
              ? 'e.g. /bin/zsh -l'
              : 'e.g. pwsh.exe or wsl.exe -d Ubuntu'
          }
        />
        <FieldError inputId="terminalShellInput" message={errors.terminalShell} />
        <span className="text-xs text-[#7f8ca0]">
          Blank = Windows Terminal default profile, else PowerShell.
        </span>
      </label>
      <HostsBlock />
    </div>
  );
}
