import { useState } from 'react';
import { routeUrl } from '../../../core/linkRouter';
import { compileLinkRules, matchLinkRule, validateLinkRule } from '../../../core/linkRules';
import type { LinkRule } from '../../../shared/ipc';
import { updateDraft, useSettingsDraft } from '../../settingsDraft';
import { errorTextClass, inputClass, saveClass } from './styles';

function FieldError({ inputId, message }: { inputId: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <span id={`${inputId}Error`} className={errorTextClass}>
      {message}
    </span>
  );
}

const PATTERN_PLACEHOLDER: Record<LinkRule['kind'], string> = {
  prefix: 'https://jira.example.com/browse/',
  regex: '^https://gitlab\\.example\\.com/.*/-/merge_requests/\\d+',
};

export function LinksTab() {
  const { draft, errors } = useSettingsDraft();
  const [testUrl, setTestUrl] = useState('');
  if (!draft) return null;
  const rules = draft.linkRules;

  const setRule = (id: string, patch: Partial<LinkRule>) => {
    updateDraft({
      linkRules: rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)),
    });
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
    </div>
  );
}
