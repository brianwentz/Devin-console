import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PTY_MARKER, ReviewOutputScanner } from '../../src/core/reviewOutput';

// A marker commits once a complete line follows it; `\nx\n` supplies that.
const TAIL = 'x\n';

function settle(...chunks: string[]) {
  const s = new ReviewOutputScanner();
  for (const c of chunks) s.scan(c);
  return s.settle();
}

describe('ReviewOutputScanner', () => {
  it('finds a marker split across chunks with SGR between', () => {
    expect(settle('AW_REVIEW_VER', '\x1b[1mDICT: chan', 'ges\n', TAIL)).toBe('changes');
  });
  it('finds a marker after a bullet', () => {
    expect(settle('● AW_REVIEW_VERDICT: approved', '\n', TAIL)).toBe('approved');
  });
  it('ignores the echoed template, also wrapped', () => {
    expect(settle('AW_REVIEW_VERDICT: approved | changes | discussion\n', TAIL)).toBeNull();
    expect(settle('AW_REVIEW_VERDICT: approved\n | changes | discussion\n', TAIL)).toBeNull();
  });
  it('is not fooled by a template split at a chunk boundary', () => {
    expect(settle('AW_REVIEW_VERDICT: approved', ' | changes | discussion\n', TAIL)).toBeNull();
    expect(settle('AW_REVIEW_VERDICT: approved\n', '| changes\n', TAIL)).toBeNull();
  });
  it('last marker wins', () => {
    expect(settle('AW_REVIEW_VERDICT: approved\n', 'AW_REVIEW_VERDICT: changes\n', TAIL)).toBe(
      'changes',
    );
  });
  it('drops text before a carriage return', () => {
    expect(settle('x\rAW_REVIEW_VERDICT: discussion\n', TAIL)).toBe('discussion');
  });
  it('treats cursor move/erase as a line break', () => {
    expect(settle('\x1b[2K\x1b[1GAW_REVIEW_VERDICT: changes\n', TAIL)).toBe('changes');
  });
  it('strips OSC sequences', () => {
    expect(settle('\x1b]133;A\x07AW_REVIEW_VERDICT: approved\x1b]133;B\x07\n', TAIL)).toBe(
      'approved',
    );
  });
  it('does not read an uncommitted marker until flush', () => {
    const s = new ReviewOutputScanner();
    expect(s.scan('AW_REVIEW_VERDICT: changes')).toBe(false);
    expect(s.settle()).toBeNull();
    s.flush();
    expect(s.settle()).toBe('changes');
  });
  it('detects a marker after a long prefix and keeps it past tail truncation', () => {
    const s = new ReviewOutputScanner();
    expect(s.scan('a'.repeat(10000))).toBe(false);
    expect(s.scan('\nAW_REVIEW_VERDICT: changes\n')).toBe(false);
    expect(s.scan(TAIL)).toBe(true);
    expect(s.scan(('b'.repeat(100) + '\n').repeat(100))).toBe(false);
    expect(s.settle()).toBe('changes');
  });
  it('exports the marker regex', () => {
    expect(PTY_MARKER.test('AW_REVIEW_VERDICT: approved | changes')).toBe(false);
  });
  it('reads the real Devin TUI capture', () => {
    const file = readFileSync(join(__dirname, '../fixtures/review-devin-tui.txt'), 'utf8');
    const expected = /# expected verdict: (\w+)/.exec(file)?.[1];
    const s = new ReviewOutputScanner();
    for (const l of file.split(/\r?\n/)) {
      if (l && !l.startsWith('#')) s.scan(JSON.parse(l) as string);
    }
    expect(s.settle()).toBe(expected);
    expect(expected).toBe('changes');
  });
});
