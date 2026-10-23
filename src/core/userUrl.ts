export const USER_URL_MAX = 8192;

export type UserUrlResult =
  | { ok: true; url: string }
  | { ok: false; reason: 'empty' | 'too-long' | 'scheme' | 'not-a-url' };

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
// `host:port` looks like a scheme to SCHEME; a numeric port tells them apart.
const HOST_PORT = /^[^:/?#\s]+:\d+(?:[/?#]|$)/;
const IPV4 =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

// Chrome behaviour: IP literals and localhost are assumed to be plain http.
function isHttpHost(host: string): boolean {
  return (
    host === 'localhost' || host.endsWith('.localhost') || host.startsWith('[') || IPV4.test(host)
  );
}

// Host-likeness of scheme-less input, judged on the text as typed (WHATWG
// parsing would turn "42" or "1.2.3" into IPv4 addresses).
function isBareHost(host: string): boolean {
  if (host.startsWith('[')) return /^\[[0-9a-f:.]+\]$/i.test(host) && host.includes(':');
  if (host === 'localhost' || IPV4.test(host)) return true;
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return false;
  return /[a-z]/i.test(labels[labels.length - 1] ?? '');
}

// Normalises text a user typed, dropped or picked (address bar, drag-and-drop,
// favorites) into an http(s) URL. Pure; routing decisions happen elsewhere.
export function normalizeUserUrl(raw: string): UserUrlResult {
  const text = raw.trim();
  if (text === '') return { ok: false, reason: 'empty' };
  if (text.length > USER_URL_MAX) return { ok: false, reason: 'too-long' };

  const scheme = SCHEME.exec(text);
  const explicit = scheme !== null && !HOST_PORT.test(text);
  if (explicit) {
    const name = (scheme[1] ?? '').toLowerCase();
    if (name !== 'http' && name !== 'https') return { ok: false, reason: 'scheme' };
  }
  if (/\s/.test(text)) return { ok: false, reason: 'not-a-url' };

  let candidate = text;
  if (!explicit) {
    const authority = /^[^/?#]*/.exec(text)?.[0] ?? '';
    // Userinfo is never accepted ("a@b.com" is an email, "github.com@evil.com" a spoof).
    if (authority.includes('@')) return { ok: false, reason: 'not-a-url' };
    const host = authority.replace(/:\d*$/, '').toLowerCase();
    if (!isBareHost(host)) return { ok: false, reason: 'not-a-url' };
    candidate = `${isHttpHost(host) ? 'http' : 'https'}://${text}`;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, reason: 'not-a-url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'scheme' };
  }
  if (url.username || url.password) return { ok: false, reason: 'not-a-url' };
  return { ok: true, url: url.href };
}
