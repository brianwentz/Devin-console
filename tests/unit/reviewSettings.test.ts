import { describe, expect, it } from 'vitest';
import { isValidReviewCommand, reviewCwdMatchesHost } from '../../src/core/reviewSettings';

describe('isValidReviewCommand', () => {
  it('needs the token, one line, 1..500 chars', () => {
    expect(isValidReviewCommand('/cb:review {github-url}')).toBe(true);
    expect(isValidReviewCommand('/x')).toBe(false);
    expect(isValidReviewCommand('/a {github-url}\nb')).toBe(false);
    expect(isValidReviewCommand('{github-url}' + 'a'.repeat(489))).toBe(false);
    expect(isValidReviewCommand('{github-url}' + 'a'.repeat(488))).toBe(true);
  });
});

describe('reviewCwdMatchesHost', () => {
  it('local takes drive/UNC/posix but never a WSL UNC path', () => {
    expect(reviewCwdMatchesHost('C:\\r', 'local')).toBe(true);
    expect(reviewCwdMatchesHost('\\\\srv\\share\\r', 'local')).toBe(true);
    expect(reviewCwdMatchesHost('\\\\wsl.localhost\\Ubuntu\\r', 'local')).toBe(false);
    expect(reviewCwdMatchesHost('\\\\wsl$\\Ubuntu\\r', 'local')).toBe(false);
  });
  it('wsl takes POSIX absolute only', () => {
    expect(reviewCwdMatchesHost('/home/u', 'wsl:Ubuntu')).toBe(true);
    expect(reviewCwdMatchesHost('C:\\r', 'wsl:Ubuntu')).toBe(false);
  });
});
