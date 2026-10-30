import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PTY_MARKER, ReviewOutputScanner } from '../../src/core/reviewOutput';

function settle(...chunks: string[]) {
  const s = new ReviewOutputScanner();
  for (const c of chunks) s.scan(c);
  return s.settle();
}

describe('ReviewOutputScanner', () => {
  it('finds a marker split across chunks with SGR between', () => {
    expect(settle('AW_REVIEW_VER', '\x1b[1mDICT: chan', 'ges\n')).toBe('changes');
  });
  it('finds a marker after a bullet', () => {
    expect(settle('● AW_REVIEW_VERDICT: approved', '\n')).toBe('approved');
  });
  it('ignores the echoed template, also wrapped', () => {
    expect(settle('AW_REVIEW_VERDICT: approved | changes | discussion\n')).toBeNull();
    expect(settle('AW_REVIEW_VERDICT: approved\n | changes | discussion\n')).toBeNull();
  });
  it('last marker wins', () => {
    expect(settle('AW_REVIEW_VERDICT: approved\n', 'AW_REVIEW_VERDICT: changes\n')).toBe('changes');
  });
  it('drops text before a carriage return', () => {
    expect(settle('x\rAW_REVIEW_VERDICT: discussion\n')).toBe('discussion');
  });
  it('treats cursor move/erase as a line break', () => {
    expect(settle('\x1b[2K\x1b[1GAW_REVIEW_VERDICT: changes')).toBe('changes');
  });
  it('strips OSC sequences', () => {
    expect(settle('\x1b]133;A\x07AW_REVIEW_VERDICT: approved\x1b]133;B\x07\n')).toBe('approved');
  });
  it('detects a marker after a long prefix', () => {
    const s = new ReviewOutputScanner();
    expect(s.scan('a'.repeat(10000))).toBe(false);
    expect(s.scan('\nAW_REVIEW_VERDICT: changes\n')).toBe(true);
    expect(s.settle()).toBe('changes');
  });
  it('scan reports only chunks that add a marker', () => {
    const s = new ReviewOutputScanner();
    expect(s.scan('hello\n')).toBe(false);
    expect(s.scan('AW_REVIEW_VERDICT: approved\n')).toBe(true);
    expect(s.scan('more\n')).toBe(false);
  });
  it('exports the marker regex', () => {
    expect(PTY_MARKER.test('AW_REVIEW_VERDICT: approved | changes')).toBe(false);
  });
  it('reads the real Devin TUI capture', () => {
    const lines = readFileSync(join(__dirname, '../fixtures/review-devin-tui.txt'), 'utf8')
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith('#'));
    const expected = /# expected verdict: (\w+)/.exec(
      readFileSync(join(__dirname, '../fixtures/review-devin-tui.txt'), 'utf8'),
    )?.[1];
    const s = new ReviewOutputScanner();
    for (const l of lines) s.scan(JSON.parse(l) as string);
    expect(expected).toBe('changes');
    expect(s.settle()).toBe(expected);
  });
});
