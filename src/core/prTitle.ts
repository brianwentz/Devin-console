// Extract the PR title from a GitHub pull-request HTML page (pure).
// GitHub's <title> looks like:
//   "Fix widget alignment by devin-ai-integration[bot] · Pull Request #42 · acme/widgets"
// We strip the " · Pull Request #N · owner/repo" suffix and, only when that
// suffix matched, the trailing " by <login>".

const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const GH_SUFFIX = /\s*·\s*Pull Request #\d+\s*·\s*\S+\s*$/;
const BY_SUFFIX = /\s+by\s+[\w.\-[\]]+$/;
const SCAN_LIMIT = 64 * 1024;

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity[0] === '#') {
      const hex = entity[1] === 'x' || entity[1] === 'X';
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isNaN(code) || code < 0 || code > 0x10ffff) return match;
      return String.fromCodePoint(code);
    }
    return NAMED[entity] ?? match;
  });
}

export function parsePrTitle(html: string): string | null {
  const match = TITLE_RE.exec(html.slice(0, SCAN_LIMIT));
  if (!match) return null;
  let title = decodeEntities(match[1]!.replace(/\s+/g, ' ')).trim();
  if (!title) return null;
  if (GH_SUFFIX.test(title)) {
    title = title.replace(GH_SUFFIX, '').replace(BY_SUFFIX, '').trim();
  }
  return title || null;
}

export type PrState = 'open' | 'draft' | 'merged' | 'closed';

// GitHub's PR header renders the state as
//   <span ... data-view-component="true" class="State State--merged ...">
// (the class attribute may carry other classes in any order) or, in older
// markup, title="Status: Merged". One alternation so the first marker in
// document order wins; other State-- modifiers (e.g. State--small) are not
// in the alternation and therefore ignored.
const STATE_SCAN_LIMIT = 256 * 1024;
const STATE_RE =
  /class\s*=\s*["'][^"']*\bState--(open|draft|merged|closed)\b[^"']*["']|title\s*=\s*["']Status:\s*(open|draft|merged|closed)["']/i;

export function parsePrState(html: string): PrState | null {
  try {
    const match = STATE_RE.exec(html.slice(0, STATE_SCAN_LIMIT));
    if (!match) return null;
    const state = (match[1] ?? match[2] ?? '').toLowerCase();
    return state === 'open' || state === 'draft' || state === 'merged' || state === 'closed'
      ? state
      : null;
  } catch {
    return null;
  }
}
