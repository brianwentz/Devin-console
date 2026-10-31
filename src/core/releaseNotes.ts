import { z } from 'zod';

export interface ReleaseNotes {
  version: string;
  name: string | null;
  publishedAt: string | null;
  body: string;
  htmlUrl: string;
}

export const RELEASE_BODY_MAX = 64 * 1024;

export function releasesPageUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}/releases`;
}

export function releaseTagUrl(
  apiBase: string,
  owner: string,
  repo: string,
  version: string,
): string {
  return `${apiBase}/repos/${owner}/${repo}/releases/tags/v${version}`;
}

const ReleaseResponseSchema = z.object({
  tag_name: z.string(),
  name: z.string().nullable().optional(),
  published_at: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  html_url: z.string(),
});

export function parseReleaseResponse(json: unknown, version: string): ReleaseNotes | null {
  const parsed = ReleaseResponseSchema.safeParse(json);
  if (!parsed.success) return null;
  const body = parsed.data.body ?? '';
  const truncated = body.length > RELEASE_BODY_MAX;
  return {
    version,
    name: parsed.data.name ?? null,
    publishedAt: parsed.data.published_at ?? null,
    body: truncated ? `${body.slice(0, RELEASE_BODY_MAX)}…` : body,
    htmlUrl: parsed.data.html_url,
  };
}
