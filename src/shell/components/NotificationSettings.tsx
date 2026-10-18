import { useEffect, useState, type FormEvent } from 'react';
import type { IdentityInfo } from '../../shared/ipc';
import { updateDraft, useSettingsDraft } from '../settingsDraft';
import { useShellState } from '../store';
import { buttonClass, errorTextClass, inputClass, inputErrorClass } from './settings/styles';

// P5: Devin API token (stored encrypted in main; never read back), the
// notifications toggle, optional org override and a test-toast button.
// The user/org id overrides are draft fields — they persist via the
// implicit-save commit on tab/surface switch or quit.
export function NotificationSettings() {
  const shell = useShellState();
  const { draft, errors } = useSettingsDraft();
  const [token, setToken] = useState('');
  const [hasToken, setHasToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [identity, setIdentity] = useState<IdentityInfo | null>(null);
  const notifications = shell?.notifications;
  const collect = shell?.settings.notifications.collect ?? true;
  const banner = shell?.settings.notifications.banner ?? true;
  const kinds = shell?.settings.notifications.kinds;
  const notificationsHasToken = notifications?.hasToken ?? false;
  const orgId = draft?.orgId ?? '';
  const userId = draft?.userId ?? '';
  const autoOpenTabs = shell?.settings.prs.autoOpenTabs ?? true;
  const identityState = notifications?.identity;
  const claudeHooksEnabled = shell?.settings.claude.hooksEnabled ?? false;
  const claudeHooks = shell?.claude.hooks;
  const claudeConfigDir = shell?.claude.configDir ?? '~/.claude';
  const claudeSettingsPath = `${claudeConfigDir}${claudeConfigDir.includes('\\') ? '\\' : '/'}settings.json`;

  useEffect(() => {
    setHasToken(notificationsHasToken);
  }, [notificationsHasToken]);
  // Re-fetch the identity info when the resolved source flips (and on mount).
  useEffect(() => {
    let alive = true;
    window.devinworkspaces
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
    window.devinworkspaces.hasPat().then(setHasToken).catch(() => undefined);

  const saveToken = (event: FormEvent) => {
    event.preventDefault();
    const value = token.trim();
    if (value.length < 10) {
      setMessage({ kind: 'error', text: 'Token must be at least 10 characters.' });
      return;
    }
    setBusy(true);
    void window.devinworkspaces
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
    void window.devinworkspaces
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

  const toggleCollect = (enabled: boolean) => {
    void window.devinworkspaces.setSettings({ notifications: { collect: enabled } });
  };
  const toggleBanner = (enabled: boolean) => {
    void window.devinworkspaces.setSettings({ notifications: { banner: enabled } });
  };
  const toggleKind = (
    key: 'waiting' | 'approval' | 'blocked' | 'finished' | 'prOpened' | 'prCompleted' | 'update',
    enabled: boolean,
  ) => {
    void window.devinworkspaces.setSettings({ notifications: { kinds: { [key]: enabled } } });
  };

  const toggleAutoOpenTabs = (enabled: boolean) => {
    void window.devinworkspaces.setSettings({ prs: { autoOpenTabs: enabled } });
  };
  const toggleClaudeHooks = (enabled: boolean) => {
    void window.devinworkspaces.setSettings({ claude: { hooksEnabled: enabled } });
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

  if (!notifications) return null;
  const status = !hasToken
    ? 'No token stored.'
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
    <section id="notificationSettings" className="flex flex-col gap-4">
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
          className={`text-xs ${notifications.authError ? 'text-[#ff8a8a]' : 'text-[#7f8ca0]'}`}
        >
          {status}
        </p>
        {hasToken && (
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
              onClick={() => window.devinworkspaces.identityReset()}
            >
              Reset
            </button>
          </p>
        )}
        {notifications.noUserIdentity && (
          <p id="patNoUser" className="text-xs text-[#ffcc80]">
            Could not determine your user — sign in with the Devin CLI (devin auth login) or set
            your user id in Settings.
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
      <label className="flex items-center gap-2 text-sm">
        <input
          id="notificationsCollectInput"
          type="checkbox"
          checked={collect}
          onChange={(event) => toggleCollect(event.target.checked)}
        />
        <span>Collect notifications</span>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          id="notificationsBannerInput"
          type="checkbox"
          checked={banner}
          onChange={(event) => toggleBanner(event.target.checked)}
        />
        <span>Show banner for new notifications</span>
      </label>
      <fieldset className="flex flex-col gap-1 text-sm">
        <span className="text-[#aeb9c8] text-xs">Notify me for</span>
        {(
          [
            ['waiting', 'Waiting for reply'],
            ['approval', 'Needs approval'],
            ['blocked', 'Blocked'],
            ['finished', 'Session finished'],
            ['prOpened', 'PR opened'],
            ['prCompleted', 'PR merged or closed'],
            ['update', 'App updates'],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="flex items-center gap-2">
            <input
              id={`notificationKind-${key}`}
              type="checkbox"
              checked={kinds?.[key] ?? true}
              onChange={(event) => toggleKind(key, event.target.checked)}
            />
            <span>{label}</span>
          </label>
        ))}
      </fieldset>
      <label className="flex items-center gap-2 text-sm">
        <input
          id="prAutoOpenTabsInput"
          type="checkbox"
          checked={autoOpenTabs}
          onChange={(event) => toggleAutoOpenTabs(event.target.checked)}
        />
        <span>Open a tab when a session creates a PR</span>
      </label>
      <div className="flex flex-col gap-1 text-sm">
        <label className="flex items-center gap-2">
          <input
            id="claudeHooksToggle"
            type="checkbox"
            checked={claudeHooksEnabled}
            onChange={(event) => toggleClaudeHooks(event.target.checked)}
          />
          <span>Report Claude Code sessions started from other terminals</span>
        </label>
        <p className="text-xs text-[#7f8ca0]">
          Writes an http hook block into {claudeSettingsPath} (removed when turned off).
        </p>
        {claudeHooks && (
          <p
            id="claudeHooksStatus"
            data-hooks-installed={claudeHooks.installed ? 'true' : 'false'}
            data-hooks-port={claudeHooks.port ?? undefined}
            className="text-xs text-[#7f8ca0]"
          >
            {claudeHooks.port === null
              ? 'Listener unavailable'
              : claudeHooks.installed
                ? `Hook installed · port ${claudeHooks.port}`
                : `Listening on port ${claudeHooks.port}`}
          </p>
        )}
        {claudeHooks?.error && (
          <p id="claudeHooksError" className={errorTextClass}>
            {claudeHooks.error}
          </p>
        )}
      </div>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[#aeb9c8]">User ID override (optional)</span>
        <input
          id="userIdInput"
          className={`${inputClass}${errors.userId ? ` ${inputErrorClass}` : ''}`}
          value={userId}
          aria-invalid={errors.userId ? 'true' : undefined}
          onChange={(event) => updateDraft({ userId: event.target.value })}
          placeholder="user-… (blank = detect automatically)"
        />
        {errors.userId && (
          <span id="userIdInputError" className={errorTextClass}>
            {errors.userId}
          </span>
        )}
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[#aeb9c8]">Organization ID (optional override)</span>
        <input
          id="orgIdInput"
          className={`${inputClass}${errors.orgId ? ` ${inputErrorClass}` : ''}`}
          value={orgId}
          aria-invalid={errors.orgId ? 'true' : undefined}
          onChange={(event) => updateDraft({ orgId: event.target.value })}
          placeholder="org-… (blank = resolve from /v3/self)"
        />
        {errors.orgId && (
          <span id="orgIdInputError" className={errorTextClass}>
            {errors.orgId}
          </span>
        )}
      </label>
    </section>
  );
}
