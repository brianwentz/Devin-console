import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CHALLENGE_NONCE_RE,
  challengeMac,
  healthChallengeNonce,
  newChallengeNonce,
  verifyChallengeMac,
} from '../../src/main/claude/hookChallenge';

// Fix round 1 #1b: the ssh hook forward is trusted only when the listener at
// the remote end of it proves it holds the bearer token — HMAC-SHA256(token,
// nonce). A squatter on the remote port cannot produce it.

describe('hook health challenge', () => {
  it('nonces are 32 lower-case hex chars and unique', () => {
    const a = newChallengeNonce();
    const b = newChallengeNonce();
    expect(a).toMatch(CHALLENGE_NONCE_RE);
    expect(a).not.toBe(b);
  });

  it('challengeMac is HMAC-SHA256(token, nonce) hex', () => {
    const nonce = '0123456789abcdef0123456789abcdef';
    expect(challengeMac('tok', nonce)).toBe(createHmac('sha256', 'tok').update(nonce).digest('hex'));
  });

  it('verify accepts only the right MAC (whitespace tolerated), rejects squatter answers', () => {
    const nonce = newChallengeNonce();
    const mac = challengeMac('tok', nonce);
    expect(verifyChallengeMac('tok', nonce, mac)).toBe(true);
    expect(verifyChallengeMac('tok', nonce, `${mac}\n`)).toBe(true);
    expect(verifyChallengeMac('tok', nonce, '{}')).toBe(false);
    expect(verifyChallengeMac('tok', nonce, '')).toBe(false);
    expect(verifyChallengeMac('other', nonce, mac)).toBe(false);
    expect(verifyChallengeMac('tok', newChallengeNonce(), mac)).toBe(false);
    expect(verifyChallengeMac('tok', 'not-a-nonce', challengeMac('tok', 'not-a-nonce'))).toBe(false);
  });

  it('healthChallengeNonce parses `<prefix>health?nonce=<n>` only', () => {
    const nonce = '0123456789abcdef0123456789abcdef';
    expect(healthChallengeNonce('/agent-workspace/hook/health?nonce=' + nonce, ['/agent-workspace/hook/'])).toBe(nonce);
    expect(healthChallengeNonce('/agent-workspace/hook/health', ['/agent-workspace/hook/'])).toBeNull();
    expect(healthChallengeNonce('/agent-workspace/hook/health?nonce=XYZ', ['/agent-workspace/hook/'])).toBe('');
    expect(healthChallengeNonce('/other/health?nonce=' + nonce, ['/agent-workspace/hook/'])).toBeNull();
  });
});
