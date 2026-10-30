import { buildReviewPrompt } from '../../../core/tabReview';
import {
  DEVIN_CLI_PERMISSION_MODES,
  isValidReviewCommand,
} from '../../../core/reviewSettings';
import {
  CLAUDE_PERMISSION_MODES,
  isClaudePermissionMode,
} from '../../../core/settingsDraft';
import { updateDraft, useSettingsDraft } from '../../settingsDraft';
import { useShellState } from '../../store';
import { FieldError, fieldInputClass } from './fields';
import { buttonClass, inputClass, sectionHeadingClass, sectionSeparatorClass } from './styles';

const EXAMPLE_PR_URL = 'https://github.com/owner/repo/pull/1';

// Tab Review runs its pty on this PC or inside a WSL distro; no WSL on macOS.
function ReviewHostSelect({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const shell = useShellState();
  const wslIds = (shell?.hosts ?? []).filter((host) => host.kind === 'wsl').map((host) => host.id);
  // Keep a configured distro that is no longer enumerated selectable.
  if (value.startsWith('wsl:') && !wslIds.includes(value)) wslIds.push(value);
  if (window.agentworkspace.platform === 'darwin') return null;
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-[#aeb9c8]">Run reviews on</span>
      <select
        id="reviewHostSelect"
        className={inputClass}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="local">This PC</option>
        {wslIds.map((id) => (
          <option key={id} value={id}>
            {id.slice('wsl:'.length)}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ReviewSection() {
  const { draft, errors } = useSettingsDraft();
  if (!draft) return null;
  const devin = draft.reviewAgent === 'devin';
  const local = draft.reviewHost === 'local';
  const previewable = isValidReviewCommand(draft.reviewCommand);

  const browse = async () => {
    const picked = await window.agentworkspace.dialogPickFolder(
      'Choose the folder reviews run in',
      draft.reviewCwd.trim() || undefined,
    );
    if (picked !== null) updateDraft({ reviewCwd: picked });
  };

  return (
    <section
      data-settings-section="links-review"
      className={`flex flex-col gap-5 ${sectionSeparatorClass}`}
    >
      <h3 className={sectionHeadingClass}>Pull request review</h3>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[#aeb9c8]">Review with</span>
        <select
          id="reviewAgentSelect"
          className={inputClass}
          style={{ maxWidth: '24rem' }}
          value={draft.reviewAgent}
          onChange={(event) =>
            updateDraft({ reviewAgent: event.target.value === 'devin' ? 'devin' : 'claude' })
          }
        >
          <option value="claude">Claude Code</option>
          <option value="devin">Devin</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[#aeb9c8]">Review command</span>
        <input
          id="reviewCommandInput"
          className={fieldInputClass(errors, 'reviewCommand')}
          value={draft.reviewCommand}
          aria-invalid={errors.reviewCommand ? 'true' : undefined}
          onChange={(event) => updateDraft({ reviewCommand: event.target.value })}
        />
        <FieldError inputId="reviewCommandInput" message={errors.reviewCommand} />
        <span id="reviewCommandHint" className="text-xs text-[#7f8ca0]">
          Slash commands must exist in the chosen agent
        </span>
        {previewable && (
          <span id="reviewCommandPreview" className="whitespace-pre-wrap text-xs text-[#7f8ca0]">
            {buildReviewPrompt(draft.reviewCommand, EXAMPLE_PR_URL)}
          </span>
        )}
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[#aeb9c8]">Permission mode</span>
        <select
          id="reviewModeSelect"
          className={inputClass}
          style={{ maxWidth: '24rem' }}
          value={devin ? draft.reviewDevinMode : draft.reviewClaudeMode}
          onChange={(event) => {
            const mode = event.target.value;
            if (devin) {
              const found = DEVIN_CLI_PERMISSION_MODES.find((entry) => entry.id === mode);
              if (found) updateDraft({ reviewDevinMode: found.id });
            } else if (isClaudePermissionMode(mode)) {
              updateDraft({ reviewClaudeMode: mode });
            }
          }}
        >
          {devin
            ? DEVIN_CLI_PERMISSION_MODES.map((mode) => (
                <option key={mode.id} value={mode.id}>
                  {mode.id}
                </option>
              ))
            : CLAUDE_PERMISSION_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {mode}
                </option>
              ))}
        </select>
      </label>
      <ReviewHostSelect value={draft.reviewHost} onChange={(next) => updateDraft({ reviewHost: next })} />
      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor="reviewCwdInput" className="text-[#aeb9c8]">
          Run reviews in
        </label>
        <div className="flex w-full max-w-md items-center gap-2">
          <input
            id="reviewCwdInput"
            className={fieldInputClass(errors, 'reviewCwd')}
            value={draft.reviewCwd}
            aria-invalid={errors.reviewCwd ? 'true' : undefined}
            onChange={(event) => updateDraft({ reviewCwd: event.target.value })}
            placeholder="e.g. C:\Users\me\src\my-repo"
          />
          {local && (
            <button id="reviewCwdBrowse" type="button" className={buttonClass} onClick={() => void browse()}>
              Browse…
            </button>
          )}
        </div>
        <FieldError inputId="reviewCwdInput" message={errors.reviewCwd} />
        <span className="text-xs text-[#7f8ca0]">
          Blank = a Reviews folder under the host home. A remote path is typed, not browsed.
        </span>
      </div>
    </section>
  );
}
