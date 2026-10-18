import { isGitHubHost } from './linkRouter';

export type PrLinkContext = { githubOrigins?: readonly string[] };

// Parens are excluded: in prose/markdown a `)` is almost always a delimiter
// (`[x](url)`, `(see url)`), and swallowing it makes the URL unparseable or
// fuses it with the next token.
const URL_RE = /https?:\/\/[^\s<>"'`()\\]+/g;
// Characters that commonly hug a URL in prose/markdown but are not part of it.
const TRAILING_NOISE = /[),.;:!?'\]>}"'`«»“”‘’]+$/;
const PR_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/;

export function stripAnsi(text: string): string {
  return (
    text
      // OSC sequences (incl. OSC 8 hyperlinks): ESC ] ... BEL or ST (ESC \)
      // eslint-disable-next-line no-control-regex -- terminal escape stripping; the control bytes are the point
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      // CSI sequences: ESC [ ... final byte
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      // remaining two-byte escapes / charset designators
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[@-Z\\-_]/g, '')
  );
}

function isAllowedOrigin(url: URL, context: PrLinkContext): boolean {
  if (isGitHubHost(url.hostname)) return true;
  const origin = url.origin.toLowerCase();
  return context.githubOrigins?.some((allowed) => allowed.toLowerCase() === origin) ?? false;
}

// Like extractPullRequestUrls but also reports each match's `end` index (one
// past the raw token, before trailing-noise stripping) — LinkScanner uses it
// to defer a URL that runs to the very end of the scanned text.
export function extractPullRequestMatches(
  text: string,
  context: PrLinkContext,
): Array<{ url: string; end: number }> {
  const out: Array<{ url: string; end: number }> = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(URL_RE)) {
    const end = match.index + match[0].length;
    let raw = match[0];
    while (raw !== (raw = raw.replace(TRAILING_NOISE, '')));
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    const path = PR_PATH.exec(url.pathname);
    if (!path || !isAllowedOrigin(url, context)) continue;
    const canonical = `${url.origin}/${path[1]}/${path[2]}/pull/${path[3]}`;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push({ url: canonical, end });
  }
  return out;
}

// Extracts canonical `origin/owner/repo/pull/N` URLs (query, fragment and
// trailing punctuation stripped), deduped, in order of appearance.
export function extractPullRequestUrls(text: string, context: PrLinkContext): string[] {
  return extractPullRequestMatches(text, context).map((match) => match.url);
}

// Stateful per-output-source scanner: strips ANSI, stitches URLs split across
// chunks via a whitespace-free carry tail, and reports each URL only once.
export class LinkScanner {
  private carry = '';
  private readonly seen = new Set<string>();
  private readonly maxCarry: number;

  constructor(private readonly opts: { context: PrLinkContext; maxCarry?: number }) {
    this.maxCarry = opts.maxCarry ?? 512;
  }

  scan(chunk: string): string[] {
    const text = this.carry + stripAnsi(chunk);
    const tail = /\S+$/.exec(text);
    this.carry = (tail ? tail[0] : '').slice(-this.maxCarry);
    const found: string[] = [];
    for (const match of extractPullRequestMatches(text, this.opts.context)) {
      // A URL ending exactly at the end of the chunk may still be growing
      // (e.g. `/pull/12` + `34`) — leave it in carry for the next scan/flush.
      if (match.end === text.length) continue;
      if (this.seen.has(match.url)) continue;
      this.seen.add(match.url);
      found.push(match.url);
    }
    return found;
  }

  // Stream ended: report whatever the carry still holds.
  flush(): string[] {
    const text = this.carry;
    this.carry = '';
    const found: string[] = [];
    for (const match of extractPullRequestMatches(text, this.opts.context)) {
      if (this.seen.has(match.url)) continue;
      this.seen.add(match.url);
      found.push(match.url);
    }
    return found;
  }
}
