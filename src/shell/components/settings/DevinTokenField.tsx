import { useEffect, useState, type FormEvent } from 'react';
import type { IdentityInfo } from '../../../shared/ipc';
import { useShellState } from '../../store';
import { buttonClass, inputClass } from './styles';

// P5: Devin API token (stored encrypted in main; never read back). Save/Clear
// and identity Reset are explicit actions, not part of the settings draft.
// The input renders before the notifications state arrives; the identity rows
// need it.
export function DevinTokenField() {
  const shell = useShellState();
  const [token, setToken] = useState('');
  const [hasToken, setHasToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [identity, setIdentity] = useState<IdentityInfo | null>(null);
  const notifications = shell?.notifications;
  const notificationsHasToken = notifications?.hasToken ?? false;
  const identityState = notifications?.identity;

  useEffect(() => {
    setHasToken(notificationsHasToken);
  }, [notificationsHasToken]);
  // Re-fetch the identity info when the resolved source flips (and on mount).
  useEffect(() => {
    let alive = true;
    window.agentworkspace
      .identity()
      .then((info) => {
        if (alive) setIdentity(info);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [identityState?.source, identityState?.resolved]);

  const refreshHasToken = () =>
    window.agentworkspace.hasPat().then(setHasToken).catch(() => undefined);

  const saveToken = (event: FormEvent) => {
    event.preventDefault();
    const value = token.trim();
    if (value.length < 10) {
      setMessage({ kind: 'error', text: 'Token must be at least 10 characters.' });
      return;
    }
    setBusy(true);
    void window.agentworkspace
      .setPat(value)
      .then((result) => {
        if (result.ok) {
          setToken('');
          setMessage({ kind: 'ok', text: 'Token stored (encrypted).' });
        } else {
          setMessage({ kind: 'error', text: result.error });
        }
        return refreshHasToken();
      })
      .finally(() => setBusy(false));
  };

  const clearToken = () => {
    setBusy(true);
    void window.agentworkspace
      .clearPat()
      .then((result) => {
        setMessage(
          result.ok
            ? { kind: 'ok', text: 'Token removed.' }
            : { kind: 'error', text: result.error },
        );
        return refreshHasToken();
      })
      .finally(() => setBusy(false));
  };

  const identityLabel = (info: IdentityInfo | null): string => {
    const masked = info?.maskedUserId ? ` (${info.maskedUserId})` : '';
    switch (info?.source) {
      case 'self':
        return 'personal token';
      case 'cli':
        return `from CLI sign-in${masked}`;
      case 'inferred':
        return `inferred from your sessions${masked}`;
      case 'manual':
        return `manual override${masked}`;
      default:
        return 'not resolved';
    }
  };

  const status = !hasToken
    ? 'No token stored.'
    : !notifications
      ? 'Token stored (encrypted).'
      : notifications.noUserIdentity
        ? 'Token has no user identity (service user) — sessions and notifications are disabled'
        : notifications.authError
          ? `Token rejected by the API (${notifications.lastError ?? 'unauthorized'}).`
          : notifications.lastPollAt
            ? `Token stored (encrypted). Last poll ${new Date(notifications.lastPollAt).toLocaleTimeString()}${
                notifications.lastError ? ` — ${notifications.lastError}` : ''
              }.`
            : 'Token stored (encrypted). Waiting for first poll…';

  return (
    <form onSubmit={saveToken} className="flex flex-col gap-1 text-sm">
      <span className="text-[#aeb9c8]">Devin API token</span>
      <div className="flex gap-2 max-w-md">
        <input
          id="patInput"
          type="password"
          autoComplete="off"
          className={inputClass}
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="Personal access token or service-user token"
        />
        <button id="patSave" type="submit" className={buttonClass} disabled={busy || token.trim().length < 10}>
          Save
        </button>
        <button
          id="patClear"
          type="button"
          className={buttonClass}
          disabled={busy || !hasToken}
          onClick={clearToken}
        >
          Clear
        </button>
      </div>
      <p
        id="patStatus"
        data-has-token={hasToken ? 'true' : 'false'}
        className={`text-xs ${notifications?.authError ? 'text-[#ff8a8a]' : 'text-[#7f8ca0]'}`}
      >
        {status}
      </p>
      {notifications && hasToken && (
        <p
          id="identityStatus"
          data-identity-source={identity?.source ?? 'none'}
          className="text-xs text-[#7f8ca0]"
        >
          Identity: {identityLabel(identity)}
          {identity?.cliOrgMismatch
            ? ' — note: the CLI’s primary org differs from the token’s org'
            : ''}
          {'  '}
          <button
            id="identityReset"
            type="button"
            className={buttonClass}
            disabled={
              !identity?.source || identity.source === 'self' || identity.source === 'manual'
            }
            onClick={() => window.agentworkspace.identityReset()}
          >
            Reset
          </button>
        </p>
      )}
      {notifications?.noUserIdentity && (
        <p id="patNoUser" className="text-xs text-[#ffcc80]">
          Could not determine your user — sign in with the Devin CLI (devin auth login) or set
          your user id in Settings → Devin.
        </p>
      )}
      {message && (
        <p className={`text-xs ${message.kind === 'ok' ? 'text-[#8fd18f]' : 'text-[#ff8a8a]'}`}>
          {message.text}
        </p>
      )}
      <p className="text-xs text-[#7f8ca0]">
        Personal access token or service-user token (legacy v1 keys are not supported). With a
        service-user token the app determines your user from the Devin CLI sign-in (devin auth
        login) or from the sessions you open; use the User ID override if neither works. Stored
        with OS encryption; never shown again.
      </p>
    </form>
  );
}
