import { describe, expect, it } from 'vitest';
import {
  parseReleaseResponse,
  releaseTagUrl,
  releasesPageUrl,
  RELEASE_BODY_MAX,
} from '../../src/core/releaseNotes';

describe('url builders', () => {
  it('builds the releases page and tag endpoints', () => {
    expect(releasesPageUrl('acme', 'widgets')).toBe(
      'https://github.com/acme/widgets/releases',
    );
    expect(releaseTagUrl('https://api.github.com', 'acme', 'widgets', '1.2.3')).toBe(
      'https://api.github.com/repos/acme/widgets/releases/tags/v1.2.3',
    );
    expect(releaseTagUrl('http://127.0.0.1:9', 'acme', 'widgets', '9.9.9')).toBe(
      'http://127.0.0.1:9/repos/acme/widgets/releases/tags/v9.9.9',
    );
  });
});

describe('parseReleaseResponse', () => {
  it('parses a GitHub-shaped response', () => {
    const notes = parseReleaseResponse(
      {
        tag_name: 'v1.2.3',
        name: 'Nice release',
        published_at: '2025-01-15T12:00:00Z',
        body: '## Fixed\n- **bold** item',
        html_url: 'https://github.com/acme/widgets/releases/tag/v1.2.3',
      },
      '1.2.3',
    );
    expect(notes).toEqual({
      version: '1.2.3',
      name: 'Nice release',
      publishedAt: '2025-01-15T12:00:00Z',
      body: '## Fixed\n- **bold** item',
      htmlUrl: 'https://github.com/acme/widgets/releases/tag/v1.2.3',
    });
  });

  it('returns null on shape mismatch', () => {
    for (const bad of [
      null,
      'nope',
      { tag_name: 'v1' }, // missing html_url
      { tag_name: 1, html_url: 'x' },
    ]) {
      expect(parseReleaseResponse(bad, '1.0.0')).toBeNull();
    }
  });

  it('defaults missing name/published_at/body', () => {
    const notes = parseReleaseResponse(
      { tag_name: 'v1.0.0', html_url: 'https://x' },
      '1.0.0',
    );
    expect(notes).toEqual({
      version: '1.0.0',
      name: null,
      publishedAt: null,
      body: '',
      htmlUrl: 'https://x',
    });
  });

  it('truncates bodies at RELEASE_BODY_MAX with a marker', () => {
    const body = 'x'.repeat(RELEASE_BODY_MAX + 10);
    const notes = parseReleaseResponse(
      { tag_name: 'v1', html_url: 'https://x', body },
      '1',
    );
    expect(notes?.body.length).toBe(RELEASE_BODY_MAX + 1);
    expect(notes?.body.endsWith('…')).toBe(true);
    expect(notes?.body.startsWith('x'.repeat(100))).toBe(true);
  });
});
