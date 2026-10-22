import { useShellState } from '../store';
import { errorTextClass } from './settings/styles';

// Notification collection, banner and per-kind toggles plus the Claude hooks
// opt-in — all instant-save. The Devin token and user/org id overrides live
// on the Devin tab (DevinTokenField / CloudTab).
export function NotificationSettings() {
  const shell = useShellState();
  const notifications = shell?.notifications;
  const collect = shell?.settings.notifications.collect ?? true;
  const banner = shell?.settings.notifications.banner ?? true;
  const kinds = shell?.settings.notifications.kinds;
  const claudeHooksEnabled = shell?.settings.claude.hooksEnabled ?? false;
  const claudeHooks = shell?.claude.hooks;
  const claudeConfigDir = shell?.claude.configDir ?? '~/.claude';
  const claudeSettingsPath = `${claudeConfigDir}${claudeConfigDir.includes('\\') ? '\\' : '/'}settings.json`;

  const toggleCollect = (enabled: boolean) => {
    void window.agentworkspace.setSettings({ notifications: { collect: enabled } });
  };
  const toggleBanner = (enabled: boolean) => {
    void window.agentworkspace.setSettings({ notifications: { banner: enabled } });
  };
  const toggleKind = (
    key:
      | 'waiting'
      | 'approval'
      | 'blocked'
      | 'finished'
      | 'prOpened'
      | 'prCompleted'
      | 'update'
      | 'usage',
    enabled: boolean,
  ) => {
    void window.agentworkspace.setSettings({ notifications: { kinds: { [key]: enabled } } });
  };

  const toggleClaudeHooks = (enabled: boolean) => {
    void window.agentworkspace.setSettings({ claude: { hooksEnabled: enabled } });
  };

  if (!notifications) return null;
  return (
    <section id="notificationSettings" className="flex flex-col gap-4">
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
            ['usage', 'Usage limits (50% / 80%)'],
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
    </section>
  );
}
