import type { DraftField } from '../../../core/settingsDraft';
import { useShellState } from '../../store';
import { errorTextClass, inputClass, inputErrorClass } from './styles';

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

export function HostsPointer() {
  return (
    <p className="text-xs text-[#7f8ca0]">
      Per-host CLI paths and shell overrides are under General → Hosts.
    </p>
  );
}
