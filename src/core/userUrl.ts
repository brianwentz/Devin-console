export const USER_URL_MAX = 8192;

export type UserUrlResult =
  | { ok: true; url: string }
  | { ok: false; reason: 'empty' | 'too-long' | 'scheme' | 'not-a-url' };

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
// `host:port` looks like a scheme to SCHEME; a numeric port tells them apart.
const HOST_PORT = /^[^:/?#\s]+:\d+(?:[/?#]|$)/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function isLocalHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.startsWith('[') ||
    IPV4.test(hostname)
  );
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
    const hostOnly = authority.replace(/^[^@]*@/, '').replace(/:\d*$/, '');
    candidate = `${isLocalHost(hostOnly.toLowerCase()) ? 'http' : 'https'}://${text}`;
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
  if (!url.hostname.includes('.') && !isLocalHost(url.hostname)) {
    return { ok: false, reason: 'not-a-url' };
  }
  return { ok: true, url: url.href };
}
