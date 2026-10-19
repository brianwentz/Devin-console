import { CLAUDE_PERMISSION_MODES, isClaudePermissionMode } from '../../../core/settingsDraft';
import { updateDraft, useSettingsDraft } from '../../settingsDraft';
import { useShellState } from '../../store';
import { CliPathHint, FieldError, HostsPointer, WslDistroSelect, fieldInputClass } from './fields';

// Mirrors the Notifications-tab checkbox: not a draft field — it commits
// immediately through setSettings, exactly like NotificationSettings does.
function HooksMirror() {
  const shell = useShellState();
  const enabled = shell?.settings.claude.hooksEnabled ?? false;
  return (
    <div className="flex flex-col gap-1 text-sm">
      <label className="flex items-center gap-2">
        <input
          id="claudeHooksEnabledMirror"
          type="checkbox"
          checked={enabled}
          onChange={(event) => {
            void window.devinworkspaces.setSettings({
              claude: { hooksEnabled: event.target.checked },
            });
          }}
        />
        <span>Report Claude Code sessions started from other terminals</span>
      </label>
      <span className="text-xs text-[#7f8ca0]">Also shown under Notifications.</span>
    </div>
  );
}

export function ClaudeTab() {
  const { draft, errors } = useSettingsDraft();
  if (!draft) return null;

  return (
    <div className="flex flex-col gap-5">
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
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[#aeb9c8]">Keep idle Claude agents warm for (minutes)</span>
        <input
          id="claudeKeepAliveInput"
          className={fieldInputClass(errors, 'claudeKeepAliveMinutes')}
          type="number"
          min={1}
          max={240}
          step={1}
          value={draft.claudeKeepAliveMinutes}
          aria-invalid={errors.claudeKeepAliveMinutes ? 'true' : undefined}
          onChange={(event) => updateDraft({ claudeKeepAliveMinutes: event.target.value })}
        />
        <FieldError inputId="claudeKeepAliveInput" message={errors.claudeKeepAliveMinutes} />
        <span className="text-xs text-[#7f8ca0]">
          Idle Claude agents are kept running this long before they are shut down.
        </span>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[#aeb9c8]">Max live Claude agents</span>
        <input
          id="claudeMaxLiveAgentsInput"
          className={fieldInputClass(errors, 'claudeMaxLiveAgents')}
          type="number"
          min={1}
          max={10}
          step={1}
          value={draft.claudeMaxLiveAgents}
          aria-invalid={errors.claudeMaxLiveAgents ? 'true' : undefined}
          onChange={(event) => updateDraft({ claudeMaxLiveAgents: event.target.value })}
        />
        <FieldError inputId="claudeMaxLiveAgentsInput" message={errors.claudeMaxLiveAgents} />
        <span className="text-xs text-[#7f8ca0]">
          Hard cap on concurrently running Claude agents; the session you're looking at is exempt.
        </span>
      </label>
      <WslDistroSelect
        id="claudeDefaultWslDistroSelect"
        value={draft.claudeDefaultWslDistro}
        onChange={(next) => updateDraft({ claudeDefaultWslDistro: next })}
      />
      <HooksMirror />
      <HostsPointer />
    </div>
  );
}
