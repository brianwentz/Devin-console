import { describe, expect, it } from 'vitest';
import { parsePrState, parsePrTitle } from '../../src/core/prTitle';

const page = (title: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body></body></html>`;

describe('parsePrTitle', () => {
  it('strips the GitHub " · Pull Request #N · owner/repo" suffix and the trailing author', () => {
    expect(
      parsePrTitle(
        page('Fix widget alignment by devin-ai-integration[bot] · Pull Request #42 · acme/widgets'),
      ),
    ).toBe('Fix widget alignment');
  });

  it('decodes named and numeric entities and collapses whitespace', () => {
    expect(
      parsePrTitle(page('Fish &amp; Chips&#39;s &lt;big&gt;   move\nby bot · Pull Request #1 · o/r')),
    ).toBe('Fish & Chips\'s <big> move');
    expect(parsePrTitle(page('a &#98;&#x63; · Pull Request #2 · o/r'))).toBe('a bc');
  });

  it('returns a non-GitHub title as-is (no "by" stripping)', () => {
    expect(parsePrTitle(page('Document by some author'))).toBe('Document by some author');
  });

  it('preserves " by " in the middle of a GitHub title', () => {
    expect(
      parsePrTitle(page('Sort by name by bot · Pull Request #5 · o/r')),
    ).toBe('Sort by name');
  });

  it('returns null when there is no title or it is empty', () => {
    expect(parsePrTitle('<html><body>no title</body></html>')).toBeNull();
    expect(parsePrTitle(page('   '))).toBeNull();
    expect(parsePrTitle(page('· Pull Request #3 · o/r'))).toBeNull();
  });

  it('caps the scan at 64 KB', () => {
    const title = `${'x'.repeat(70 * 1024)}<title>late</title>`;
    expect(parsePrTitle(title)).toBeNull();
  });
});

describe('parsePrState', () => {
  const body = (inner: string) => `<html><head><title>t</title></head><body>${inner}</body></html>`;

  it('reads the State--<state> class in GitHub\'s header span', () => {
    for (const state of ['open', 'draft', 'merged', 'closed'] as const) {
      expect(
        parsePrState(
          body(`<span title="Status: ${state}" data-view-component="true" class="State State--${state}">x</span>`),
        ),
      ).toBe(state);
      expect(parsePrState(body(`<div class="State State--${state}">`))).toBe(state);
    }
  });

  it('tolerates extra classes in any order', () => {
    expect(parsePrState(body('<span class="State State--merged State--small">'))).toBe('merged');
    expect(parsePrState(body('<span class="flex-shrink-0 State--open State mr-2">'))).toBe('open');
    expect(parsePrState(body("<span class='State State--draft'>"))).toBe('draft');
  });

  it('reads the title="Status: X" form case-insensitively', () => {
    expect(parsePrState(body('<span title="Status: Merged">'))).toBe('merged');
    expect(parsePrState(body('<span title="Status: CLOSED">'))).toBe('closed');
    expect(parsePrState(body('<span title="Status:Draft">'))).toBe('draft');
    expect(parsePrState(body('<span title="Status: open">'))).toBe('open');
  });

  it('ignores unrelated State-- modifiers and returns null without a marker', () => {
    expect(parsePrState(body('<span class="State State--small">'))).toBeNull();
    expect(parsePrState(body('<p>Status: merged</p>'))).toBeNull();
    expect(parsePrState(body('State--merged'))).toBeNull();
    expect(parsePrState('')).toBeNull();
  });

  it('takes the first marker in document order', () => {
    expect(
      parsePrState(
        body('<span class="State State--open"></span><span class="State State--merged"></span>'),
      ),
    ).toBe('open');
    expect(
      parsePrState(body('<a title="Status: Closed"></a><span class="State State--open"></span>')),
    ).toBe('closed');
  });

  it('caps the scan at 256 KB', () => {
    const late = `${'x'.repeat(257 * 1024)}<span class="State State--merged">`;
    expect(parsePrState(late)).toBeNull();
    const inRange = `${'x'.repeat(200 * 1024)}<span class="State State--merged">`;
    expect(parsePrState(inRange)).toBe('merged');
  });
});
