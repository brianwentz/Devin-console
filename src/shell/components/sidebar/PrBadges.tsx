import {
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
} from 'lucide-react';
import type { CloudSessionState } from '../../../shared/ipc';

type PrCounts = CloudSessionState['prs'];

// PR status badge group — same buckets/colours as the web sidebar. The count
// is hidden when exactly one bucket is present with a single PR.
export const PR_BUCKETS: {
  key: keyof PrCounts;
  label: string;
  color: string;
  Icon: typeof GitPullRequest;
}[] = [
  { key: 'open', label: 'open', color: '#3fb950', Icon: GitPullRequest },
  { key: 'queued', label: 'queued', color: '#d29922', Icon: GitPullRequest },
  { key: 'draft', label: 'draft', color: '#8b9bb0', Icon: GitPullRequestDraft },
  { key: 'merged', label: 'merged', color: '#a371f7', Icon: GitMerge },
  { key: 'closed', label: 'closed', color: '#f85149', Icon: GitPullRequestClosed },
];

export function PrBadges({ prs }: { prs: PrCounts }) {
  const present = PR_BUCKETS.filter((b) => prs[b.key] > 0);
  if (present.length === 0) return null;
  const hideCount = present.length === 1 && prs[present[0]!.key] === 1;
  const title = present.map((b) => `${prs[b.key]} ${b.label}`).join(', ');
  return (
    <span className="shrink-0 flex items-center gap-1" title={title}>
      {present.map(({ key, color, Icon }) => (
        <span key={key} className="flex items-center" style={{ color }}>
          <Icon size={12} />
          {!hideCount && (
            <span className="text-[11px] leading-[14px] ml-0.5">{prs[key]}</span>
          )}
        </span>
      ))}
    </span>
  );
}
