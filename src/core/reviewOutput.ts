import { stripAnsi } from './prLinks';
import type { ReviewVerdict } from './tabReview';

/** Unanchored: a TUI prefixes the line. The lookahead rejects the echoed
 * `approved | changes | discussion` template. */
export const PTY_MARKER = /AW_REVIEW_VERDICT:\s*(approved|changes|discussion)\b(?!\s*\|)/i;

const CARRY_MAX = 8192;

/** OSC dropped, cursor-move/erase CSI -> line break, other escapes dropped. */
function normalise(raw: string): string {
  return stripAnsi(
    raw
      // eslint-disable-next-line no-control-regex -- terminal escape handling
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-?]*[ -/]*[HfABCDEFGJdK]/g, '\n'),
  );
}

/** Text after the last `\r` of a line (a carriage return overwrites the line). */
function visible(line: string): string {
  const k = line.lastIndexOf('\r');
  return k >= 0 ? line.slice(k + 1) : line;
}

/**
 * Reads the verdict marker out of a review pty's raw output (Devin's TUI
 * redraws with cursor moves). A marker only counts on a committed line: one
 * that is newline-terminated and followed by another complete line (so the
 * wrapped-template `|` continuation can be seen), or anything left at
 * `flush()`. The uncommitted tail is carried, never read. Not `parseVerdict`:
 * its assessment fallback would misfire on TUI text.
 */
export class ReviewOutputScanner {
  private carry = '';
  private latest: ReviewVerdict | null = null;

  /** True when this chunk committed a marker hit. */
  scan(chunk: string): boolean {
    return this.commit(false, chunk);
  }

  /** Pty exit: everything still carried counts as complete. */
  flush(): void {
    this.commit(true, '');
  }

  /** The latest committed verdict (last marker wins), or null. */
  settle(): ReviewVerdict | null {
    return this.latest;
  }

  private commit(all: boolean, chunk: string): boolean {
    const lines = normalise(this.carry + chunk).split(/\r?\n/);
    // lines[last] is the unterminated remainder; lines[last - 1] has no
    // complete successor yet.
    const end = all ? lines.length : Math.max(0, lines.length - 2);
    let hit = false;
    for (let i = 0; i < end; i++) {
      const m = PTY_MARKER.exec(visible(lines[i] ?? ''));
      if (!m) continue;
      if (visible(lines[i + 1] ?? '').trimStart().startsWith('|')) continue;
      this.latest = (m[1] ?? '').toLowerCase() as ReviewVerdict;
      hit = true;
    }
    this.carry = all ? '' : lines.slice(end).join('\n').slice(-CARRY_MAX);
    return hit;
  }
}
