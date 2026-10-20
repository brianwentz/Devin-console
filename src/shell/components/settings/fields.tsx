import type { DraftField } from '../../../core/settingsDraft';
import { useShellState } from '../../store';
import { buttonClass, errorTextClass, inputClass, inputErrorClass } from './styles';

// Non-empty claude.path that didn't resolve — surfaced inline under the
// field from the live claude state rather than as a commit-blocking error.
export function CliPathHint() {
  const state = useShellState();
  if (!state || state.claude.cliPath !== null) return null;
  return (
    <span id="claudePathInputError" className={errorTextClass}>
      Claude CLI not found at this path
    </span>
  );
}

export function fieldInputClass(
  errors: Partial<Record<DraftField, string>>,
  field: DraftField,
): string {
  return errors[field] ? `${inputClass} ${inputErrorClass}` : inputClass;
}

export function FieldError({ inputId, message }: { inputId: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <span id={`${inputId}Error`} className={errorTextClass}>
      {message}
    </span>
  );
}

// Shared by the Devin Local and Claude Code tabs: the WSL distros the hosts
// layer enumerated, or a muted line when there are none.
export function WslDistroSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
}) {
  const state = useShellState();
  const wslHosts = (state?.hosts ?? []).filter((host) => host.kind === 'wsl');
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-[#aeb9c8]">Default WSL distro for new sessions</span>
      {wslHosts.length > 0 ? (
        <select
          id={id}
          className={inputClass}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">none</option>
          {wslHosts.map((host) => (
            <option key={host.id} value={host.label}>
              {host.label}
            </option>
          ))}
        </select>
      ) : (
        <span className="text-xs text-[#7f8ca0]">No WSL distros detected.</span>
      )}
    </label>
  );
}

// ux3 S3: shared by the Devin Local and Claude Code tabs — where that
// surface's folder pickers start. Browse… starts in the current value and
// writes the pick into the draft (null = cancelled → unchanged).
export function PickerFolderField({
  id,
  browseId,
  value,
  error,
  hint,
  onChange,
}: {
  id: string;
  browseId: string;
  value: string;
  error: string | undefined;
  hint: string;
  onChange: (next: string) => void;
}) {
  const browse = async () => {
    const picked = await window.devinworkspaces.dialogPickFolder(
      'Choose where folder pickers start',
      value.trim() || undefined,
    );
    if (picked !== null) onChange(picked);
  };
  return (
    <div className="flex flex-col gap-1 text-sm">
      <label htmlFor={id} className="text-[#aeb9c8]">
        Folder pickers start in
      </label>
      <div className="flex items-center gap-2 w-full max-w-md">
        <input
          id={id}
          className={error ? `${inputClass} ${inputErrorClass}` : inputClass}
          value={value}
          aria-invalid={error ? 'true' : undefined}
          onChange={(event) => onChange(event.target.value)}
          placeholder="e.g. C:\Users\me\src or \\wsl.localhost\Ubuntu\home\me"
        />
        <button id={browseId} type="button" className={buttonClass} onClick={() => void browse()}>
          Browse…
        </button>
      </div>
      <FieldError inputId={id} message={error} />
      <span className="text-xs text-[#7f8ca0]">
        {hint} Blank = the default WSL distro's home when one is set, else the system default.
      </span>
    </div>
  );
}

export function HostsPointer() {
  return (
    <p className="text-xs text-[#7f8ca0]">
      Per-host CLI paths and shell overrides are under General → Hosts.
    </p>
  );
}
