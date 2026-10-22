import { updateDraft, useSettingsDraft } from '../../settingsDraft';
import { DevinTokenField } from './DevinTokenField';
import { FieldError, fieldInputClass } from './fields';

export function CloudTab() {
  const { draft, errors } = useSettingsDraft();
  if (!draft) return null;

  return (
    <div className="flex flex-col gap-5">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[#aeb9c8]">Tenant URL</span>
        <input
          id="tenantUrlInput"
          className={fieldInputClass(errors, 'tenantUrl')}
          value={draft.tenantUrl}
          aria-invalid={errors.tenantUrl ? 'true' : undefined}
          onChange={(event) => updateDraft({ tenantUrl: event.target.value })}
          placeholder="https://cloudbeds.devinenterprise.com"
        />
        <FieldError inputId="tenantUrlInput" message={errors.tenantUrl} />
        <span className="text-xs text-[#7f8ca0]">
          Restart not required — Cloud view reloads on tenant change.
        </span>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[#aeb9c8]">API base</span>
        <input
          id="apiBaseInput"
          className={fieldInputClass(errors, 'apiBase')}
          value={draft.apiBase}
          aria-invalid={errors.apiBase ? 'true' : undefined}
          onChange={(event) => updateDraft({ apiBase: event.target.value })}
          placeholder="https://api.devin.ai"
        />
        <FieldError inputId="apiBaseInput" message={errors.apiBase} />
      </label>
      <DevinTokenField />
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[#aeb9c8]">User ID override (optional)</span>
        <input
          id="userIdInput"
          className={fieldInputClass(errors, 'userId')}
          value={draft.userId}
          aria-invalid={errors.userId ? 'true' : undefined}
          onChange={(event) => updateDraft({ userId: event.target.value })}
          placeholder="user-… (blank = detect automatically)"
        />
        <FieldError inputId="userIdInput" message={errors.userId} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[#aeb9c8]">Organization ID (optional override)</span>
        <input
          id="orgIdInput"
          className={fieldInputClass(errors, 'orgId')}
          value={draft.orgId}
          aria-invalid={errors.orgId ? 'true' : undefined}
          onChange={(event) => updateDraft({ orgId: event.target.value })}
          placeholder="org-… (blank = resolve from /v3/self)"
        />
        <FieldError inputId="orgIdInput" message={errors.orgId} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[#aeb9c8]">Check Devin Cloud usage every (minutes)</span>
        <input
          id="usageDevinPollMinutes"
          className={fieldInputClass(errors, 'usageDevinPollMinutes')}
          type="number"
          min={5}
          max={240}
          step={1}
          value={draft.usageDevinPollMinutes}
          aria-invalid={errors.usageDevinPollMinutes ? 'true' : undefined}
          onChange={(event) => updateDraft({ usageDevinPollMinutes: event.target.value })}
        />
        <FieldError inputId="usageDevinPollMinutes" message={errors.usageDevinPollMinutes} />
        <span className="text-xs text-[#7f8ca0]">
          How often the app polls your monthly ACU usage for alerts (50% / 80%).
        </span>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[#aeb9c8]">Cloud sessions kept loaded</span>
        <input
          id="sessionsMaxLiveViews"
          className={fieldInputClass(errors, 'sessionsMaxLiveViews')}
          type="number"
          min={1}
          max={20}
          step={1}
          value={draft.sessionsMaxLiveViews}
          aria-invalid={errors.sessionsMaxLiveViews ? 'true' : undefined}
          onChange={(event) => updateDraft({ sessionsMaxLiveViews: event.target.value })}
        />
        <FieldError inputId="sessionsMaxLiveViews" message={errors.sessionsMaxLiveViews} />
        <span className="text-xs text-[#7f8ca0]">
          Pooled Cloud views — the session you're looking at is exempt.
        </span>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[#aeb9c8]">
          Keep hidden Cloud sessions live for (hours, 0 = discard on switch)
        </span>
        <input
          id="sessionsKeepAliveHours"
          className={fieldInputClass(errors, 'sessionsKeepAliveHours')}
          type="number"
          min={0}
          max={168}
          step={1}
          value={draft.sessionsKeepAliveHours}
          aria-invalid={errors.sessionsKeepAliveHours ? 'true' : undefined}
          onChange={(event) =>
            updateDraft({ sessionsKeepAliveHours: event.target.value })
          }
        />
        <FieldError inputId="sessionsKeepAliveHours" message={errors.sessionsKeepAliveHours} />
        <span className="text-xs text-[#7f8ca0]">
          Switched-away Cloud sessions reload after this long.
        </span>
      </label>
    </div>
  );
}
