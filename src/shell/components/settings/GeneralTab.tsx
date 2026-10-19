import { useState } from 'react';
import {
  CLAUDE_PERMISSION_MODES,
  isClaudePermissionMode,
  type DraftField,
} from '../../../core/settingsDraft';
import { updateDraft, useSettingsDraft } from '../../settingsDraft';
import { useShellState } from '../../store';
import { errorTextClass, inputClass, inputErrorClass, saveClass } from './styles';

// Non-empty claude.path that didn't resolve — surfaced inline under the
// field from the live claude state rather than as a commit-blocking error.
function CliPathHint() {
  const state = useShellState();
  if (!state || state.claude.cliPath !== null) return null;
  return (
    <span id="claudePathInputError" className={errorTextClass}>
      Claude CLI not found at this path
    </span>
  );
}

function fieldInputClass(errors: Partial<Record<DraftField, string>>, field: DraftField): string {
  return errors[field] ? `${inputClass} ${inputErrorClass}` : inputClass;
}

function FieldError({ inputId, message }: { inputId: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <span id={`${inputId}Error`} className={errorTextClass}>
      {message}
    </span>
  );
}

function HostsBlock() {
  const state = useShellState();
  const { draft } = useSettingsDraft();
  const [openOverrides, setOpenOverrides] = useState<string | null>(null);
  if (!state || !draft) return null;
  const hosts = state.hosts ?? [];
  const wslHosts = hosts.filter((host) => host.kind === 'wsl');
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
    void window.devinworkspaces.commitSettings({
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
            <span className="text-[#dfe6ef]">{host.label}</span>
            <span data-host-state className="text-xs text-[#7f8ca0]">
              {host.state}
            </span>
            {host.kind === 'wsl' && (
              <label className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  data-host-enabled
                  checked={host.state !== 'disabled' && host.state !== 'stopped'}
                  onChange={(event) => {
                    void window.devinworkspaces.hostsSetEnabled(
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
              onClick={() => void window.devinworkspaces.hostsRefresh(host.id)}
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
          </div>
          <span data-host-facts className="text-xs text-[#7f8ca0]">
            {facts(host)}
          </span>
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
      {wslHosts.length > 0 ? (
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[#aeb9c8]">Default WSL distro for new sessions</span>
          <select
            id="defaultWslDistroSelect"
            className={inputClass}
            value={draft.defaultWslDistro}
            onChange={(event) => updateDraft({ defaultWslDistro: event.target.value })}
          >
            <option value="">none</option>
            {wslHosts.map((host) => (
              <option key={host.id} value={host.label}>
                {host.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}

export function GeneralTab() {
  const { draft, errors } = useSettingsDraft();
  const [newWorkspace, setNewWorkspace] = useState('');
  if (!draft) return null;
  const workspaces = draft.workspaces;

  return (
    <div className="flex flex-col gap-5">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[#aeb9c8]">Tenant URL</span>
        <input
          id="tenantUrlInput"
          className={fieldInputClass(errors, 'tenantUrl')}
          value={draft.tenantUrl}
          aria-invalid={errors.tenantUrl ? 'true' : undefined}
          onChange={(event) => updateDraft({ tenantUrl: event.target.value })}
          placeholder="https://cloudbeds.devinenterprise.com"
        />
        <FieldError inputId="tenantUrlInput" message={errors.tenantUrl} />
        <span className="text-xs text-[#7f8ca0]">
          Restart not required — Cloud view reloads on tenant change.
        </span>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[#aeb9c8]">API base</span>
        <input
          id="apiBaseInput"
          className={fieldInputClass(errors, 'apiBase')}
          value={draft.apiBase}
          aria-invalid={errors.apiBase ? 'true' : undefined}
          onChange={(event) => updateDraft({ apiBase: event.target.value })}
          placeholder="https://api.devin.ai"
        />
        <FieldError inputId="apiBaseInput" message={errors.apiBase} />
      </label>
      <div className="flex flex-col gap-1 text-sm">
        <span className="text-[#aeb9c8]">Workspaces</span>
        <ul className="flex flex-col gap-1 max-w-md">
          {workspaces.map((workspace) => (
            <li key={workspace} className="flex items-center gap-2">
              <span className="flex-1 truncate font-mono text-xs">{workspace}</span>
              <button
                type="button"
                className={saveClass}
                onClick={() =>
                  updateDraft({ workspaces: workspaces.filter((entry) => entry !== workspace) })
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        <div className="flex gap-2 max-w-md">
          <input
            id="workspaceInput"
            className={fieldInputClass(errors, 'workspaces')}
            value={newWorkspace}
            aria-invalid={errors.workspaces ? 'true' : undefined}
            onChange={(event) => setNewWorkspace(event.target.value)}
            placeholder="C:\path\to\workspace"
          />
          <button
            type="button"
            className={saveClass}
            onClick={() => {
              const value = newWorkspace.trim();
              if (value && !workspaces.includes(value)) {
                updateDraft({ workspaces: [...workspaces, value] });
              }
              setNewWorkspace('');
            }}
          >
            Add
          </button>
        </div>
        <FieldError inputId="workspaceInput" message={errors.workspaces} />
      </div>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[#aeb9c8]">Keep hidden tabs live for (hours, 0 = discard on switch)</span>
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
        <span className="text-[#aeb9c8]">Cloud sessions kept loaded</span>
        <input
          id="sessionsMaxLiveViews"
          className={fieldInputClass(errors, 'sessionsMaxLiveViews')}
          type="number"
          min={1}
          max={20}
          step={1}
          value={draft.sessionsMaxLiveViews}
          aria-invalid={errors.sessionsMaxLiveViews ? 'true' : undefined}
          onChange={(event) => updateDraft({ sessionsMaxLiveViews: event.target.value })}
        />
        <FieldError inputId="sessionsMaxLiveViews" message={errors.sessionsMaxLiveViews} />
        <span className="text-xs text-[#7f8ca0]">
          Pooled Cloud views — the session you're looking at is exempt.
        </span>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[#aeb9c8]">
          Keep hidden Cloud sessions live for (hours, 0 = discard on switch)
        </span>
        <input
          id="sessionsKeepAliveHours"
          className={fieldInputClass(errors, 'sessionsKeepAliveHours')}
          type="number"
          min={0}
          max={168}
          step={1}
          value={draft.sessionsKeepAliveHours}
          aria-invalid={errors.sessionsKeepAliveHours ? 'true' : undefined}
          onChange={(event) =>
            updateDraft({ sessionsKeepAliveHours: event.target.value })
          }
        />
        <FieldError inputId="sessionsKeepAliveHours" message={errors.sessionsKeepAliveHours} />
        <span className="text-xs text-[#7f8ca0]">
          Switched-away Cloud sessions reload after this long.
        </span>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          id="sessionsColumnToggle"
          type="checkbox"
          checked={draft.sessionsOpen}
          onChange={(event) => updateDraft({ sessionsOpen: event.target.checked })}
        />
        <span>Show the sessions column (Cloud and Claude)</span>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[#aeb9c8]">Claude Code path</span>
        <input
          id="claudePathInput"
          className={fieldInputClass(errors, 'claudePath')}
          value={draft.claudePath}
          aria-invalid={errors.claudePath ? 'true' : undefined}
          onChange={(event) => updateDraft({ claudePath: event.target.value })}
          placeholder="e.g. C:\Users\me\.local\bin\claude.exe"
        />
        <FieldError inputId="claudePathInput" message={errors.claudePath} />
        {draft.claudePath.trim() !== '' && (
          <CliPathHint />
        )}
        <span className="text-xs text-[#7f8ca0]">
          Blank = find claude on PATH.
        </span>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[#aeb9c8]">
          Auto-archive Claude sessions idle for (days, 0 = off)
        </span>
        <input
          id="claudeAutoArchiveInput"
          className={fieldInputClass(errors, 'claudeAutoArchiveDays')}
          type="number"
          min={0}
          max={365}
          step={1}
          value={draft.claudeAutoArchiveDays}
          aria-invalid={errors.claudeAutoArchiveDays ? 'true' : undefined}
          onChange={(event) =>
            updateDraft({ claudeAutoArchiveDays: event.target.value })
          }
        />
        <FieldError inputId="claudeAutoArchiveInput" message={errors.claudeAutoArchiveDays} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[#aeb9c8]">Default permission mode for new Claude sessions</span>
        <select
          id="claudePermissionModeDefault"
          className={fieldInputClass(errors, 'claudePermissionMode')}
          value={draft.claudePermissionMode}
          onChange={(event) => {
            const mode = event.target.value;
            if (isClaudePermissionMode(mode)) updateDraft({ claudePermissionMode: mode });
          }}
        >
          {CLAUDE_PERMISSION_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {mode}
            </option>
          ))}
        </select>
        <FieldError inputId="claudePermissionModeDefault" message={errors.claudePermissionMode} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[#aeb9c8]">Claude model</span>
        <input
          id="claudeModelInput"
          className={fieldInputClass(errors, 'claudeModel')}
          value={draft.claudeModel}
          aria-invalid={errors.claudeModel ? 'true' : undefined}
          onChange={(event) => updateDraft({ claudeModel: event.target.value })}
          placeholder="e.g. claude-sonnet-4-5"
        />
        <FieldError inputId="claudeModelInput" message={errors.claudeModel} />
        <span className="text-xs text-[#7f8ca0]">
          Blank = the Claude CLI's default model. Applies to new sessions.
        </span>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          id="terminalAllSurfacesInput"
          type="checkbox"
          checked={draft.terminalAllSurfaces}
          onChange={(event) => updateDraft({ terminalAllSurfaces: event.target.checked })}
        />
        <span>Show terminal dock on Local and Settings too</span>
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
            window.devinworkspaces.platform === 'darwin'
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
