import { describe, expect, it } from 'vitest';
import {
  REVIEW_VERDICT_RETRY_MS,
  buildReviewPrompt,
  canonicalPrUrl,
  lastAssistantText,
  reviewPromptArg,
  reviewRetryDelays,
  parseVerdict,
  prLabel,
  reduceReview,
  resolveReviewHostPure,
  reviewDotLabel,
  tabMenuModel,
  verdictSource,
  type ReviewRecord,
} from '../../src/core/tabReview';

const rec = (over: Partial<ReviewRecord> = {}): ReviewRecord => ({
  tabId: 't1',
  sessionId: 's1',
  hostId: 'local',
  ptyId: 'p1',
  prUrl: 'https://github.com/o/r/pull/12',
  originScope: 'claude:abc',
  status: 'reviewing',
  startedAt: 1,
  finishedAt: null,
  terminalOpen: true,
  ...over,
});

describe('parseVerdict', () => {
  it('reads the marker', () => {
    expect(parseVerdict('done\nAW_REVIEW_VERDICT: changes')).toEqual({
      verdict: 'changes',
      via: 'marker',
    });
  });
  it('last marker wins', () => {
    expect(parseVerdict('AW_REVIEW_VERDICT: approved\nmore\nAW_REVIEW_VERDICT: discussion')?.verdict).toBe(
      'discussion',
    );
  });
  it('rejects the template line', () => {
    expect(parseVerdict('AW_REVIEW_VERDICT: approved | changes | discussion')).toBeNull();
  });
  it('ignores case and decoration', () => {
    expect(parseVerdict('**`aw_review_verdict: Approved`**')).toEqual({
      verdict: 'approved',
      via: 'marker',
    });
  });
  it('falls back to the assessment', () => {
    expect(parseVerdict('**Overall Assessment:** Approved')?.verdict).toBe('approved');
    expect(parseVerdict('**Overall Assessment:** Changes Requested')).toEqual({
      verdict: 'changes',
      via: 'assessment',
    });
    expect(parseVerdict('Overall Assessment: Needs Discussion')?.verdict).toBe('discussion');
  });
  it('handles CRLF', () => {
    expect(parseVerdict('x\r\nAW_REVIEW_VERDICT: changes\r\n')?.verdict).toBe('changes');
  });
  it('last assessment wins', () => {
    expect(
      parseVerdict('Overall Assessment: Approved\nOverall Assessment: Needs Discussion')?.verdict,
    ).toBe('discussion');
  });
  it('marker beats assessment', () => {
    expect(parseVerdict('Overall Assessment: Approved\nAW_REVIEW_VERDICT: changes')).toEqual({
      verdict: 'changes',
      via: 'marker',
    });
  });
  it('returns null when neither is present', () => {
    expect(parseVerdict('looks fine to me')).toBeNull();
  });
  it('the built prompt carries no standalone marker', () => {
    expect(parseVerdict(buildReviewPrompt('https://github.com/o/r/pull/1'))).toBeNull();
  });
});

describe('buildReviewPrompt', () => {
  it('starts with the command and has the marker instruction', () => {
    const u = 'https://github.com/o/r/pull/12';
    const p = buildReviewPrompt(u);
    expect(p.startsWith(`/cb:review ${u}\n`)).toBe(true);
    expect(p).toContain('AW_REVIEW_VERDICT: approved | changes | discussion');
  });
});

describe('canonicalPrUrl / prLabel', () => {
  it('strips sub-path, query and hash', () => {
    expect(canonicalPrUrl('https://github.com/o/r/pull/12/files?w=1#x')).toBe(
      'https://github.com/o/r/pull/12',
    );
  });
  it('keeps scheme, port and case', () => {
    expect(canonicalPrUrl('http://127.0.0.1:4010/o/r/pull/3/commits')).toBe(
      'http://127.0.0.1:4010/o/r/pull/3',
    );
    expect(canonicalPrUrl('https://github.com/Org/Repo/pull/12#discussion_r1')).toBe(
      'https://github.com/Org/Repo/pull/12',
    );
    expect(prLabel('https://github.com/Org/Repo/pull/12/files')).toBe('Org/Repo#12');
  });
  it('is null for a non-PR url', () => {
    expect(canonicalPrUrl('https://github.com/o/r')).toBeNull();
  });
  it('rejects owner/repo with characters GitHub names never carry (cmd.exe %VAR% expansion)', () => {
    expect(canonicalPrUrl('https://github.com/%25PATH%25/r/pull/1')).toBeNull();
    expect(canonicalPrUrl('https://github.com/o/%PATH%/pull/1')).toBeNull();
    expect(canonicalPrUrl('https://github.com/o/r%20x/pull/1')).toBeNull();
    expect(canonicalPrUrl('https://github.com/my-org/my.repo_2/pull/1')).toBe(
      'https://github.com/my-org/my.repo_2/pull/1',
    );
  });
  it('labels owner/repo#n', () => {
    expect(prLabel('https://github.com/o/r/pull/12')).toBe('o/r#12');
  });
});

describe('reduceReview', () => {
  it('verdict while reviewing', () => {
    const r = reduceReview(rec(), { type: 'verdict', verdict: 'changes', at: 9 });
    expect(r.status).toBe('changes');
    expect(r.finishedAt).toBe(9);
  });
  it('verdict on a finished record is ignored', () => {
    const done = rec({ status: 'approved', finishedAt: 5 });
    expect(reduceReview(done, { type: 'verdict', verdict: 'changes', at: 9 })).toEqual(done);
  });
  it('exit while reviewing ends it', () => {
    const r = reduceReview(rec(), { type: 'exit', at: 9 });
    expect(r.status).toBe('ended');
    expect(r.ptyId).toBeNull();
  });
  it('exit after a verdict keeps the status', () => {
    const r = reduceReview(rec({ status: 'approved', finishedAt: 5 }), { type: 'exit', at: 9 });
    expect(r.status).toBe('approved');
    expect(r.ptyId).toBeNull();
    expect(r.finishedAt).toBe(5);
  });
  it('close-terminal while reviewing ends it', () => {
    const r = reduceReview(rec(), { type: 'close-terminal', at: 9 });
    expect(r.status).toBe('ended');
    expect(r.terminalOpen).toBe(false);
  });
  it('close-terminal after a verdict keeps the status', () => {
    const r = reduceReview(rec({ status: 'changes' }), { type: 'close-terminal', at: 9 });
    expect(r.status).toBe('changes');
    expect(r.terminalOpen).toBe(false);
  });
  it('show-terminal reopens', () => {
    expect(reduceReview(rec({ terminalOpen: false }), { type: 'show-terminal' }).terminalOpen).toBe(true);
  });
});

describe('tabMenuModel', () => {
  const pr = 'https://github.com/o/r/pull/12';
  it('non-PR disables review', () => {
    const m = tabMenuModel('https://example.com/', null, false);
    expect(m.map((i) => [i.label, i.enabled])).toEqual([
      ['Copy address', true],
      ['Review pull request', false],
    ]);
  });
  it('non-PR with a status still disables review', () => {
    expect(tabMenuModel('https://example.com/', 'approved', false).map((i) => i.enabled)).toEqual([
      true,
      false,
    ]);
  });
  it('PR with no review enables review', () => {
    expect(tabMenuModel(pr, null, false)[1]).toMatchObject({ action: 'review', enabled: true });
  });
  it('reviewing disables review and offers the terminal when hidden', () => {
    const m = tabMenuModel(pr, 'reviewing', true);
    expect(m[1]).toMatchObject({ action: 'review', enabled: false });
    expect(m[2]).toMatchObject({ action: 'show-review', label: 'Show review terminal' });
    expect(tabMenuModel(pr, 'reviewing', false)).toHaveLength(2);
  });
  it('finished review offers re-run', () => {
    expect(tabMenuModel(pr, 'approved', false)[1]).toMatchObject({
      action: 'rerun',
      label: 'Re-run review',
      enabled: true,
    });
  });
  it('finished review with a live hidden pty offers re-run and show', () => {
    expect(tabMenuModel(pr, 'approved', true).map((i) => i.action)).toEqual(['copy', 'rerun', 'show-review']);
  });
  it('finished review with the strip shown (or no pty) offers re-run only', () => {
    expect(tabMenuModel(pr, 'approved', false).map((i) => i.action)).toEqual(['copy', 'rerun']);
    expect(tabMenuModel(pr, 'ended', false).map((i) => i.action)).toEqual(['copy', 'rerun']);
  });
  it('non-PR never offers show', () => {
    expect(tabMenuModel('https://example.com/', 'approved', true).map((i) => i.action)).toEqual(['copy', 'review']);
  });
});

describe('reviewDotLabel', () => {
  it('has a label per status', () => {
    expect(reviewDotLabel('reviewing')).toBe('Reviewing…');
    expect(reviewDotLabel('approved')).toBe('Review: approved');
    expect(reviewDotLabel('changes')).toBe('Review: changes requested');
    expect(reviewDotLabel('discussion')).toBe('Review: needs discussion');
    expect(reviewDotLabel('ended')).toBe('Review ended');
  });
});

describe('resolveReviewHostPure', () => {
  const ready = { listed: true, enabled: true, fsReady: true, stopped: false };
  it('ignores a stale wsl setting off Windows', () => {
    expect(resolveReviewHostPure('wsl:D', 'darwin', null)).toEqual({ ok: true, hostId: 'local' });
  });
  it('local on win32', () => {
    expect(resolveReviewHostPure('local', 'win32', null)).toEqual({ ok: true, hostId: 'local' });
  });
  it('unlisted or disabled distro', () => {
    const bad = { reason: 'distro-unavailable', ok: false };
    expect(resolveReviewHostPure('wsl:D', 'win32', null)).toEqual(bad);
    expect(resolveReviewHostPure('wsl:D', 'win32', { ...ready, listed: false })).toEqual(bad);
    expect(resolveReviewHostPure('wsl:D', 'win32', { ...ready, enabled: false })).toEqual(bad);
  });
  it('helper not ready', () => {
    expect(resolveReviewHostPure('wsl:D', 'win32', { ...ready, fsReady: false })).toEqual({
      ok: false,
      reason: 'helper-not-ready',
    });
  });
  it('ready distro', () => {
    expect(resolveReviewHostPure('wsl:D', 'win32', ready)).toEqual({ ok: true, hostId: 'wsl:D' });
  });
  it('a listed + enabled Stopped distro is started, not refused', () => {
    const stopped = { ...ready, fsReady: false, stopped: true };
    expect(resolveReviewHostPure('wsl:D', 'win32', stopped)).toStrictEqual({
      ok: true,
      hostId: 'wsl:D',
      start: true,
    });
    // Stopped but not listed/enabled still refuses.
    expect(resolveReviewHostPure('wsl:D', 'win32', { ...stopped, enabled: false })).toEqual({
      ok: false,
      reason: 'distro-unavailable',
    });
  });
});

describe('verdictSource', () => {
  it('uses the Stop payload text when last_assistant_message is a string', () => {
    const text = 'done\nAW_REVIEW_VERDICT: approved';
    expect(verdictSource({ last_assistant_message: text })).toEqual({ kind: 'payload', text });
    expect(verdictSource({ last_assistant_message: '' })).toEqual({ kind: 'payload', text: '' });
  });

  it('falls back to the transcript when the field is absent or not a string', () => {
    expect(verdictSource({})).toEqual({ kind: 'transcript' });
    expect(verdictSource({ last_assistant_message: 42 })).toEqual({ kind: 'transcript' });
    expect(verdictSource({ last_assistant_message: null })).toEqual({ kind: 'transcript' });
  });

  it('retries a null transcript read at 1 s, 3 s and 7 s after Stop', () => {
    expect(REVIEW_VERDICT_RETRY_MS).toEqual([1000, 3000, 7000]);
  });
});

describe('lastAssistantText', () => {
  const assistant = (content: unknown, extra: Record<string, unknown> = {}) => ({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { role: 'assistant', content },
    ...extra,
  });

  it('returns the text blocks of the last top-level assistant message with text', () => {
    const messages = [
      { type: 'user', message: { role: 'user', content: 'AW_REVIEW_VERDICT: approved | changes | discussion' } },
      assistant([{ type: 'text', text: 'first' }]),
      assistant([
        { type: 'text', text: 'Summary' },
        { type: 'tool_use', id: 't', name: 'Bash', input: {} },
        { type: 'text', text: 'AW_REVIEW_VERDICT: changes' },
      ]),
      assistant([{ type: 'tool_use', id: 't2', name: 'Read', input: {} }]),
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } },
    ];
    expect(lastAssistantText(messages)).toBe('Summary\nAW_REVIEW_VERDICT: changes');
  });

  it('accepts a plain string content', () => {
    expect(lastAssistantText([assistant('AW_REVIEW_VERDICT: approved')])).toBe(
      'AW_REVIEW_VERDICT: approved',
    );
  });

  it('skips subagent assistant messages and user text', () => {
    const messages = [
      assistant([{ type: 'text', text: 'parent' }]),
      assistant([{ type: 'text', text: 'AW_REVIEW_VERDICT: approved' }], { parent_tool_use_id: 'tu1' }),
      { type: 'user', message: { role: 'user', content: 'AW_REVIEW_VERDICT: approved' } },
    ];
    expect(lastAssistantText(messages)).toBe('parent');
  });

  it('returns null when there is no assistant text', () => {
    expect(lastAssistantText([])).toBeNull();
    expect(lastAssistantText([null, 'x', { type: 'assistant' }])).toBeNull();
    expect(lastAssistantText([assistant([{ type: 'tool_use', id: 't', name: 'Bash', input: {} }])])).toBeNull();
  });
});

describe('reviewRetryDelays', () => {
  it('measures the 1 s / 3 s / 7 s re-reads from the Stop', () => {
    expect(reviewRetryDelays(0)).toEqual([1000, 3000, 7000]);
    expect(reviewRetryDelays(400)).toEqual([600, 2600, 6600]);
  });

  it('runs an overdue re-read at once', () => {
    expect(reviewRetryDelays(3500)).toEqual([0, 0, 3500]);
    expect(reviewRetryDelays(9000)).toEqual([0, 0, 0]);
  });
});

describe('reviewPromptArg', () => {
  const prompt = buildReviewPrompt('https://github.com/o/r/pull/7');

  it('passes the prompt unchanged to an executable', () => {
    expect(reviewPromptArg(prompt, 'C:\\Users\\u\\.local\\bin\\claude.exe')).toBe(prompt);
    expect(reviewPromptArg(prompt, null)).toBe(prompt);
  });

  it('flattens line breaks for a cmd.exe shim, keeping the marker instruction', () => {
    const arg = reviewPromptArg(prompt, 'C:\\npm\\claude.CMD');
    expect(arg).not.toMatch(/[\r\n]/);
    expect(arg).toContain('/cb:review https://github.com/o/r/pull/7');
    expect(arg).toContain('AW_REVIEW_VERDICT: approved | changes | discussion');
    expect(reviewPromptArg('a\r\n\r\nb', 'x.bat')).toBe('a b');
  });
});
