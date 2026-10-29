import { describe, expect, it } from 'vitest';
import { reviewsDirFor } from '../../src/core/tabReview';

describe('reviewsDirFor', () => {
  it('joins with posix separators', () => {
    expect(reviewsDirFor('/home/u', 'posix')).toBe('/home/u/.agent-workspace/reviews');
  });
  it('joins with win32 separators', () => {
    expect(reviewsDirFor('C:\\Users\\u', 'win32')).toBe('C:\\Users\\u\\.agent-workspace\\reviews');
  });
});
