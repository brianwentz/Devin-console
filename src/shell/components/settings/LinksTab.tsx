import { useEffect, useState } from 'react';
import { routeUrl } from '../../../core/linkRouter';
import { compileLinkRules, matchLinkRule, validateLinkRule } from '../../../core/linkRules';
import type { FavoritesProfilesReply, LinkRule } from '../../../shared/ipc';
import { updateDraft, useSettingsDraft } from '../../settingsDraft';
import { useShellState } from '../../store';
import { FieldError, fieldInputClass } from './fields';
import { ReviewSection } from './ReviewSection';
import {
  errorTextClass,
  inputClass,
  saveClass,
  sectionHeadingClass,
  sectionSeparatorClass,
} from './styles';

const PATTERN_PLACEHOLDER: Record<LinkRule['kind'], string> = {
  prefix: 'https://jira.example.com/browse/',
  regex: '^https://gitlab\\.example\\.com/.*/-/merge_requests/\\d+',
};

type ChromeProfile = FavoritesProfilesReply['profiles'][number];

// Read-only Chrome profile list for the Favorites menu; null while loading.
function useChromeProfiles(): ChromeProfile[] | null {
  const [profiles, setProfiles] = useState<ChromeProfile[] | null>(null);
  useEffect(() => {
    let live = true;
    window.agentworkspace
      .favoritesProfiles()
      .then((reply) => {
        if (live) setProfiles(reply.profiles);
      })
      .catch(() => {
        if (live) setProfiles([]);
      });
    return () => {
      live = false;
    };
  }, []);
  return profiles;
}

function FavoritesSection({ value, error }: { value: string; error: string | undefined }) {
  const profiles = useChromeProfiles();
  // A configured profile Chrome no longer lists stays selected (never silently changed).
  const unlisted = value !== '' && profiles !== null && !profiles.some((p) => p.dir === value);
  return (
    <section
      data-settings-section="links-favorites"
      className={`flex flex-col gap-3 ${sectionSeparatorClass}`}
    >
      <h3 className={sectionHeadingClass}>Favorites</h3>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[#aeb9c8]">Chrome profile</span>
        <select
          id="favoritesProfileSelect"
          className={inputClass}
          style={{ maxWidth: '24rem' }}
          value={value}
          aria-invalid={error ? 'true' : undefined}
          onChange={(event) => updateDraft({ favoritesChromeProfile: event.target.value })}
        >
          <option value="">Last used Chrome profile</option>
          {(profiles ?? []).map((profile) => (
            <option key={profile.dir} value={profile.dir}>
              {profile.name}
            </option>
          ))}
          {(unlisted || (value !== '' && profiles === null)) && (
            <option value={value}>{profiles === null ? value : `${value} (not found)`}</option>
          )}
        </select>
        <FieldError inputId="favoritesProfileSelect" message={error} />
        <span className="text-xs text-[#7f8ca0]">
          The favorites menu shows this profile's bookmarks, read from Google Chrome (read-only).
        </span>
        {profiles !== null && profiles.length === 0 && (
          <span className="text-xs text-[#7f8ca0]">
            Google Chrome profiles not found
          </span>
        )}
      </label>
    </section>
  );
}

export function LinksTab() {
  const { draft, errors } = useSettingsDraft();
  const shell = useShellState();
  const [testUrl, setTestUrl] = useState('');
  if (!draft) return null;
  const autoOpenTabs = shell?.settings.prs.autoOpenTabs ?? true;
  const rules = draft.linkRules;

  const setRule = (id: string, patch: Partial<LinkRule>) => {
    updateDraft({
      linkRules: rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)),
    });
  };

  // Instant-save like the other checkboxes outside the draft.
  const toggleAutoOpenTabs = (enabled: boolean) => {
    void window.agentworkspace.setSettings({ prs: { autoOpenTabs: enabled } });
  };

  const testResult = (): string => {
    const value = testUrl.trim();
    if (!value) return '';
    const kind = routeUrl(value, {
      tenantUrl: draft.tenantUrl,
      rules: compileLinkRules(rules),
    });
    if (kind === 'github') return 'GitHub';
    if (kind === 'devin') return 'Devin';
    if (kind === 'rule') {
      const matched = matchLinkRule(value, compileLinkRules(rules));
      const index = rules.findIndex((rule) => rule.id === matched?.id);
      return `Rule ${index + 1} (${matched?.kind ?? 'prefix'}) → opens as tab`;
    }
    if (kind === 'external') return 'External (system browser)';
    return 'Not a valid http(s) URL';
  };

  return (
    <div className="flex flex-col gap-5">
      <p className="text-xs text-[#7f8ca0] max-w-2xl">
        Links matching these rules open as tabs in the Linked Context pane instead of the system browser.
        GitHub and your Devin tenant are always handled first.
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input
          id="allowExternalInput"
          type="checkbox"
          checked={draft.allowExternal}
          onChange={(event) => updateDraft({ allowExternal: event.target.checked })}
        />
        <span>Open non-GitHub links in system browser</span>
      </label>
      <ul id="linkRulesList" className="flex flex-col gap-3">
        {rules.map((rule) => {
          const invalid = rule.pattern.trim()
            ? validateLinkRule({ kind: rule.kind, pattern: rule.pattern.trim() })
            : null;
          return (
            <li
              key={rule.id}
              data-rule-id={rule.id}
              data-rule-invalid={invalid ? 'true' : 'false'}
              className="flex flex-col gap-1"
            >
              <div className="flex items-center gap-2">
                <select
                  data-rule-kind
                  className={inputClass}
                  style={{ maxWidth: '12rem' }}
                  value={rule.kind}
                  onChange={(event) =>
                    setRule(rule.id, { kind: event.target.value as LinkRule['kind'] })
                  }
                >
                  <option value="prefix">Prefix</option>
                  <option value="regex">Regular expression</option>
                </select>
                <input
                  data-rule-pattern
                  className={inputClass}
                  style={{ maxWidth: '24rem' }}
                  value={rule.pattern}
                  aria-invalid={invalid ? 'true' : undefined}
                  onChange={(event) => setRule(rule.id, { pattern: event.target.value })}
                  placeholder={PATTERN_PLACEHOLDER[rule.kind]}
                />
                <label className="flex items-center gap-1 text-sm">
                  <input
                    data-rule-enabled
                    type="checkbox"
                    checked={rule.enabled}
                    onChange={(event) => setRule(rule.id, { enabled: event.target.checked })}
                  />
                  <span>Enabled</span>
                </label>
                <button
                  type="button"
                  data-rule-remove
                  className={saveClass}
                  onClick={() =>
                    updateDraft({ linkRules: rules.filter((entry) => entry.id !== rule.id) })
                  }
                >
                  Remove
                </button>
              </div>
              {invalid && <span className={errorTextClass}>{invalid}</span>}
            </li>
          );
        })}
      </ul>
      <div>
        <button
          id="linkRuleAdd"
          type="button"
          className={saveClass}
          onClick={() =>
            updateDraft({
              linkRules: [
                ...rules,
                { id: crypto.randomUUID(), kind: 'prefix', pattern: '', enabled: true },
              ],
            })
          }
        >
          Add rule
        </button>
        <FieldError inputId="linkRuleAdd" message={errors.linkRules} />
      </div>
      <div className="flex flex-col gap-1 text-sm">
        <span className="text-[#aeb9c8]">Test a URL</span>
        <input
          id="linkRuleTestInput"
          className={inputClass}
          value={testUrl}
          onChange={(event) => setTestUrl(event.target.value)}
          placeholder="https://example.com/path"
        />
        <span id="linkRuleTestResult" className="text-xs text-[#7f8ca0]">
          {testResult()}
        </span>
      </div>
      <section
        data-settings-section="links-linked-context"
        className={`flex flex-col gap-5 ${sectionSeparatorClass}`}
      >
        <h3 className={sectionHeadingClass}>Tabs</h3>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[#aeb9c8]">
            Keep hidden GitHub tabs live for (hours, 0 = discard on switch)
          </span>
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
        <label className="flex items-center gap-2 text-sm">
          <input
            id="prAutoOpenTabsInput"
            type="checkbox"
            checked={autoOpenTabs}
            onChange={(event) => toggleAutoOpenTabs(event.target.checked)}
          />
          <span>Open a tab when a session creates a PR</span>
        </label>
      </section>
      <ReviewSection />
      <FavoritesSection value={draft.favoritesChromeProfile} error={errors.favoritesChromeProfile} />
    </div>
  );
}
