import { describe, expect, it } from 'vitest';
import {
  openHandsAuthOrigins,
  isConversationId,
  openhandsMenuEntries,
  openhandsStatusLine,
  parseExtraAuthOrigins,
  openhandsOwnsUrl,
  openhandsViewKey,
  OPENHANDS_IDP_AUTH_ORIGINS,
} from '../../src/core/openhands';

const ID = '0123456789abcdef0123456789abcd01';

describe('openHandsAuthOrigins', () => {
  it('adds the all-hands auth hosts for app.all-hands.dev, plus the git IdPs', () => {
    expect(openHandsAuthOrigins('https://app.all-hands.dev')).toEqual([
      'https://auth.app.all-hands.dev',
      'https://auth.all-hands.dev',
      ...OPENHANDS_IDP_AUTH_ORIGINS,
    ]);
  });

  it('lists the exact IdP prefixes', () => {
    expect(OPENHANDS_IDP_AUTH_ORIGINS).toEqual([
      'https://github.com/login',
      'https://github.com/sessions',
      'https://gitlab.com/oauth',
      'https://gitlab.com/users/sign_in',
      'https://bitbucket.org/site/oauth2',
      'https://bitbucket.org/account/signin',
    ]);
  });

  it('matches the all-hands host case-insensitively and ignores paths', () => {
    expect(openHandsAuthOrigins('https://APP.all-hands.dev/')[0]).toBe('https://auth.app.all-hands.dev');
  });

  it('uses only the IdP prefixes for a custom host', () => {
    expect(openHandsAuthOrigins('https://oh.corp.example')).toEqual([...OPENHANDS_IDP_AUTH_ORIGINS]);
    expect(openHandsAuthOrigins('not a url')).toEqual([...OPENHANDS_IDP_AUTH_ORIGINS]);
  });

  it('appends extra origins (test fixture) after the defaults, without duplicates', () => {
    const out = openHandsAuthOrigins('https://oh.corp.example', [
      'http://localhost:1234',
      'https://github.com/login',
    ]);
    expect(out.slice(-1)).toEqual(['http://localhost:1234']);
    expect(out.filter((o) => o === 'https://github.com/login')).toHaveLength(1);
  });
});

describe('parseExtraAuthOrigins', () => {
  it('splits a comma list and drops blanks and non-http(s) entries', () => {
    expect(parseExtraAuthOrigins(' http://localhost:1 , ,https://a.test/login,ftp://x,nope')).toEqual([
      'http://localhost:1',
      'https://a.test/login',
    ]);
    expect(parseExtraAuthOrigins(undefined)).toEqual([]);
    expect(parseExtraAuthOrigins('')).toEqual([]);
  });
});

describe('openhandsViewKey / openhandsOwnsUrl', () => {
  const base = 'https://oh.test';
  it('keys a conversation page by its id and other base pages as home', () => {
    expect(openhandsViewKey(`https://oh.test/conversations/${ID}`, base)).toBe(ID);
    expect(openhandsViewKey(`https://oh.test/conversations/${ID}?x=1`, base)).toBe(ID);
    expect(openhandsViewKey('https://oh.test/', base)).toBe('home');
    expect(openhandsViewKey('https://oh.test/settings', base)).toBe('home');
  });

  it('returns null for a foreign origin or an unparseable URL', () => {
    expect(openhandsViewKey(`https://other.test/conversations/${ID}`, base)).toBeNull();
    expect(openhandsViewKey('nope', base)).toBeNull();
    expect(openhandsViewKey('https://oh.test/', 'nope')).toBeNull();
  });

  it('owns only the exact origin', () => {
    expect(openhandsOwnsUrl('https://oh.test/a', base)).toBe(true);
    expect(openhandsOwnsUrl('https://OH.test/a', base)).toBe(true);
    expect(openhandsOwnsUrl('http://oh.test/a', base)).toBe(false);
    expect(openhandsOwnsUrl('https://oh.test:8443/a', base)).toBe(false);
    expect(openhandsOwnsUrl('https://oh.test.evil/a', base)).toBe(false);
    expect(openhandsOwnsUrl('nope', base)).toBe(false);
  });

  it('works for a base URL with a path', () => {
    expect(openhandsViewKey(`http://127.0.0.1:9/oh/conversations/${ID}`, 'http://127.0.0.1:9/oh')).toBe(ID);
    expect(openhandsOwnsUrl('http://127.0.0.1:9/elsewhere', 'http://127.0.0.1:9/oh')).toBe(true);
  });
});

describe('openhandsMenuEntries', () => {
  const caps = { rename: true, delete: true };
  it('session menu: rename, copy id, open in browser, then delete', () => {
    expect(openhandsMenuEntries('session', caps)).toEqual([
      { id: 'rename', label: 'Rename…' },
      { id: 'copy-id', label: 'Copy session ID' },
      { id: 'open-in-browser', label: 'Open in browser' },
      'separator',
      { id: 'delete', label: 'Delete…' },
    ]);
  });

  it('drops rename / delete (and the separator) the source does not advertise', () => {
    expect(
      openhandsMenuEntries('session', { rename: false, delete: false }).map((e) =>
        e === 'separator' ? e : e.id,
      ),
    ).toEqual(['copy-id', 'open-in-browser']);
  });

  it('header menu: new session and refresh', () => {
    expect(openhandsMenuEntries('header', caps).map((e) => (e === 'separator' ? e : e.id))).toEqual([
      'new-session',
      'refresh',
    ]);
  });
});

describe('openhandsStatusLine', () => {
  it('maps status + connection to the sidebar status text', () => {
    expect(openhandsStatusLine('idle', 'idle')).toBe('Not connected yet');
    expect(openhandsStatusLine('connecting', 'idle')).toBeUndefined();
    expect(openhandsStatusLine('ready', 'api-key')).toBeUndefined();
    expect(openhandsStatusLine('error', 'login-required')).toBe('Sign in to OpenHands to load sessions');
    expect(openhandsStatusLine('error', 'api-key-required')).toBe('OpenHands needs an API key to load sessions');
    expect(openhandsStatusLine('error', 'api-key-rejected')).toBe('OpenHands rejected the API key');
    expect(openhandsStatusLine('error', 'error')).toBe("Couldn't load OpenHands sessions");
  });
});

describe('isConversationId', () => {
  const base = 'https://oh.test';
  it('accepts a real conversation id', () => {
    expect(isConversationId(base, ID)).toBe(true);
  });
  it('rejects tampered ids', () => {
    for (const id of ['../x', 'a/b', `${ID}?x=1`, `${ID}#h`, `${ID}/../y`, '', 'short', `${ID}0`]) {
      expect(isConversationId(base, id)).toBe(false);
    }
  });
});
