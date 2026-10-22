// Hook-forward proof (fix round 1 #1b): `GET <prefix>health?nonce=<n>` on the
// hook listener answers HMAC-SHA256(token, nonce). The app sends a fresh nonce
// through the ssh forward (a remote `curl`) and trusts the forward only when
// the answer verifies — a process squatting the remote port can return 200 but
// not this MAC. No electron import (unit-tested directly).

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const CHALLENGE_NONCE_RE = /^[0-9a-f]{32}$/;

export function newChallengeNonce(): string {
  return randomBytes(16).toString('hex');
}

export function challengeMac(token: string, nonce: string): string {
  return createHmac('sha256', token).update(nonce).digest('hex');
}

export function verifyChallengeMac(token: string, nonce: string, answer: string): boolean {
  if (!CHALLENGE_NONCE_RE.test(nonce) || !token) return false;
  const expected = Buffer.from(challengeMac(token, nonce));
  const given = Buffer.from(answer.trim());
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** `<prefix>health?nonce=<n>` → the nonce ('' when malformed); null for any other URL. */
export function healthChallengeNonce(url: string, prefixes: readonly string[]): string | null {
  const q = url.indexOf('?');
  if (q === -1) return null;
  const path = url.slice(0, q);
  if (!prefixes.some((p) => path === `${p}health`)) return null;
  const nonce = new URLSearchParams(url.slice(q + 1)).get('nonce') ?? '';
  return CHALLENGE_NONCE_RE.test(nonce) ? nonce : '';
}
