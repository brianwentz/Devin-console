import { stripAnsi } from './prLinks';
import type { ReviewVerdict } from './tabReview';

/** Unanchored: a TUI prefixes the line. The lookahead rejects the echoed
 * `approved | changes | discussion` template. */
export const PTY_MARKER = /AW_REVIEW_VERDICT:\s*(approved|changes|discussion)\b(?!\s*\|)/i;

const TAIL_MAX = 8192;

/** Terminal text as lines: OSC dropped, cursor-move/erase CSI -> line break,
 * other escapes dropped, text before the last `\r` of a line discarded. */
function toLines(raw: string): string[] {
  const text = stripAnsi(
    raw
      // eslint-disable-next-line no-control-regex -- terminal escape handling
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-?]*[ -/]*[HfABCDEFGJdK]/g, '\n'),
  );
  return text.split(/\r?\n/).map((l) => {
    const k = l.lastIndexOf('\r');
    return k >= 0 ? l.slice(k + 1) : l;
  });
}

/** Every marker verdict in `raw`, in order. A marker line followed by a line
 * starting with `|` is the template wrapped, not a verdict. */
function verdictsIn(raw: string): ReviewVerdict[] {
  const lines = toLines(raw);
  const out: ReviewVerdict[] = [];
  lines.forEach((line, i) => {
    const m = PTY_MARKER.exec(line);
    if (!m) return;
    if ((lines[i + 1] ?? '').trimStart().startsWith('|')) return;
    out.push((m[1] ?? '').toLowerCase() as ReviewVerdict);
  });
  return out;
}

/**
 * Reads the verdict marker out of a review pty's raw output (Devin's TUI
 * redraws with cursor moves, so the text is rebuilt from a bounded raw tail).
 * Not `parseVerdict`: its assessment fallback would misfire on TUI text.
 */
export class ReviewOutputScanner {
  private tail = '';
  private latest: ReviewVerdict | null = null;

  /** True when this chunk added a marker hit. */
  scan(chunk: string): boolean {
    this.tail = (this.tail + chunk).slice(-TAIL_MAX);
    const prefix = this.tail.slice(0, Math.max(0, this.tail.length - chunk.length));
    const after = verdictsIn(this.tail);
    const grew = after.length > verdictsIn(prefix).length;
    const last = after[after.length - 1];
    if (last) this.latest = last;
    return grew;
  }

  /** The latest verdict seen (last marker wins), or null. */
  settle(): ReviewVerdict | null {
    return this.latest;
  }
}
