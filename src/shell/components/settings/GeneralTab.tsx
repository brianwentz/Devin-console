import { useState } from 'react';
import type { DraftField } from '../../../core/settingsDraft';
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
    </div>
  );
}
