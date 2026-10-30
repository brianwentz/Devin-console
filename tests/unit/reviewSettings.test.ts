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
  it('local on win32 takes drive/UNC but never a WSL UNC or POSIX path', () => {
    expect(reviewCwdMatchesHost('C:\\r', 'local', 'win32')).toBe(true);
    expect(reviewCwdMatchesHost('\\\\srv\\share\\r', 'local', 'win32')).toBe(true);
    expect(reviewCwdMatchesHost('\\\\wsl.localhost\\Ubuntu\\r', 'local', 'win32')).toBe(false);
    expect(reviewCwdMatchesHost('\\\\wsl$\\Ubuntu\\r', 'local', 'win32')).toBe(false);
    expect(reviewCwdMatchesHost('/home/u', 'local', 'win32')).toBe(false);
  });
  it('local on darwin takes POSIX only', () => {
    expect(reviewCwdMatchesHost('/Users/x', 'local', 'darwin')).toBe(true);
    expect(reviewCwdMatchesHost('C:\\x', 'local', 'darwin')).toBe(false);
  });
  it('wsl takes a single-rooted POSIX path only', () => {
    expect(reviewCwdMatchesHost('/home/u', 'wsl:Ubuntu', 'win32')).toBe(true);
    expect(reviewCwdMatchesHost('C:\\r', 'wsl:Ubuntu', 'win32')).toBe(false);
    expect(reviewCwdMatchesHost('//srv/x', 'wsl:U', 'win32')).toBe(false);
  });
});
