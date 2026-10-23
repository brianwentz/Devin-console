import type { ProviderId } from '../core/providers';

/**
 * React-free declaration of which optional shell slots each provider fills in
 * `providers.tsx`. `PROVIDER_UI` is type-checked against this record, so adding
 * a slot in one place without the other fails typecheck.
 */
export const PROVIDER_UI_KEYS = {
  'devin-cloud': { analyticsPanel: true, sourceGlyph: false },
  'devin-local': { analyticsPanel: false, sourceGlyph: false },
  claude: { analyticsPanel: true, sourceGlyph: true },
  openhands: { analyticsPanel: false, sourceGlyph: false },
} as const satisfies Record<ProviderId, { analyticsPanel: boolean; sourceGlyph: boolean }>;
