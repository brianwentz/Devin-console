import { useState, type FormEvent } from 'react';
import type { OpenHandsConnection } from '../../../shared/ipc';
import { updateDraft, useSettingsDraft } from '../../settingsDraft';
import { useShellState } from '../../store';
import { FieldError, fieldInputClass } from './fields';
import { buttonClass, inputClass } from './styles';

const CONNECTION_TEXT: Record<OpenHandsConnection, string> = {
  idle: 'Not connected yet.',
  'api-key': 'Connected with the API key.',
  'api-key-rejected': 'The API key was rejected — check it or clear it to use the web sign-in.',
  'api-key-required': 'This OpenHands server needs an API key.',
  'web-session': 'Connected with the web sign-in.',
  'login-required': 'Sign in to OpenHands from the OpenHands view, or set an API key.',
  error: 'Could not reach OpenHands.',
};

// API key: stored encrypted in main and never read back. Save/Clear are
// explicit actions (not part of the implicit-save draft).
function OpenHandsApiKeyField() {
  const shell = useShellState();
  const keySet = shell?.openhandsApiKeySet ?? false;
  const connection = shell?.openhands.connection ?? 'idle';
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const save = (event: FormEvent) => {
    event.preventDefault();
    const key = value.trim();
    if (!key) return;
    setBusy(true);
    void window.agentworkspace
      .openhandsApiKeySet(key)
      .then((result) => {
        setValue('');
        setMessage(
          result.ok
            ? { kind: 'ok', text: 'API key stored (encrypted).' }
            : { kind: 'error', text: 'Could not store the API key.' },
        );
      })
      .catch(() => setMessage({ kind: 'error', text: 'Could not store the API key.' }))
      .finally(() => setBusy(false));
  };

  const clear = () => {
    setBusy(true);
    void window.agentworkspace
      .openhandsApiKeyClear()
      .then((result) =>
        setMessage(
          result.ok
            ? { kind: 'ok', text: 'API key removed.' }
            : { kind: 'error', text: 'Could not remove the API key.' },
        ),
      )
      .catch(() => setMessage({ kind: 'error', text: 'Could not remove the API key.' }))
      .finally(() => setBusy(false));
  };

  return (
    <form onSubmit={save} className="flex flex-col gap-1 text-sm">
      <span className="text-[#aeb9c8]">OpenHands API key</span>
      <div className="flex gap-2 max-w-md">
        <input
          id="openhandsApiKeyInput"
          type="password"
          autoComplete="off"
          className={inputClass}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={keySet ? 'Stored — enter a new key to replace it' : 'Optional'}
        />
        <button
          id="openhandsApiKeySave"
          type="submit"
          className={buttonClass}
          disabled={busy || value.trim() === ''}
        >
          Save
        </button>
        <button
          id="openhandsApiKeyClear"
          type="button"
          className={buttonClass}
          disabled={busy || !keySet}
          onClick={clear}
        >
          Clear
        </button>
      </div>
      <p
        id="openhandsConnectionStatus"
        data-status={connection}
        data-key-set={keySet ? 'true' : 'false'}
        className={`text-xs ${
          connection === 'api-key-rejected' || connection === 'error'
            ? 'text-[#ff8a8a]'
            : 'text-[#7f8ca0]'
        }`}
      >
        {CONNECTION_TEXT[connection]}
        {keySet ? ' An API key is stored.' : ' No API key stored.'}
      </p>
      {message && (
        <p className={`text-xs ${message.kind === 'ok' ? 'text-[#8fd18f]' : 'text-[#ff8a8a]'}`}>
          {message.text}
        </p>
      )}
      <p className="text-xs text-[#7f8ca0]">
        Optional. Without a key the app uses your OpenHands web sign-in. Stored with OS
        encryption; never shown again.
      </p>
    </form>
  );
}

export function OpenHandsTab() {
  const { draft, errors } = useSettingsDraft();
  if (!draft) return null;

  return (
    <div className="flex flex-col gap-5">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[#aeb9c8]">OpenHands URL</span>
        <input
          id="openhandsBaseUrlInput"
          className={fieldInputClass(errors, 'openhandsBaseUrl')}
          value={draft.openhandsBaseUrl}
          aria-invalid={errors.openhandsBaseUrl ? 'true' : undefined}
          onChange={(event) => updateDraft({ openhandsBaseUrl: event.target.value })}
          placeholder="https://app.all-hands.dev"
        />
        <FieldError inputId="openhandsBaseUrlInput" message={errors.openhandsBaseUrl} />
        <span className="text-xs text-[#7f8ca0]">
          OpenHands Cloud, or your own server (https; a sub-path is allowed).
        </span>
      </label>
      <OpenHandsApiKeyField />
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[#aeb9c8]">Check for conversation updates every (seconds)</span>
        <input
          id="openhandsPollSecondsInput"
          className={fieldInputClass(errors, 'openhandsPollSeconds')}
          type="number"
          min={10}
          max={600}
          step={1}
          value={draft.openhandsPollSeconds}
          aria-invalid={errors.openhandsPollSeconds ? 'true' : undefined}
          onChange={(event) => updateDraft({ openhandsPollSeconds: event.target.value })}
        />
        <FieldError inputId="openhandsPollSecondsInput" message={errors.openhandsPollSeconds} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[#aeb9c8]">OpenHands conversations kept loaded</span>
        <input
          id="openhandsMaxLiveViewsInput"
          className={fieldInputClass(errors, 'openhandsMaxLiveViews')}
          type="number"
          min={1}
          max={20}
          step={1}
          value={draft.openhandsMaxLiveViews}
          aria-invalid={errors.openhandsMaxLiveViews ? 'true' : undefined}
          onChange={(event) => updateDraft({ openhandsMaxLiveViews: event.target.value })}
        />
        <FieldError inputId="openhandsMaxLiveViewsInput" message={errors.openhandsMaxLiveViews} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[#aeb9c8]">Keep hidden OpenHands conversations live for (hours)</span>
        <input
          id="openhandsKeepAliveInput"
          className={fieldInputClass(errors, 'openhandsKeepAliveHours')}
          type="number"
          min={0}
          max={168}
          step={1}
          value={draft.openhandsKeepAliveHours}
          aria-invalid={errors.openhandsKeepAliveHours ? 'true' : undefined}
          onChange={(event) => updateDraft({ openhandsKeepAliveHours: event.target.value })}
        />
        <FieldError inputId="openhandsKeepAliveInput" message={errors.openhandsKeepAliveHours} />
      </label>
    </div>
  );
}
