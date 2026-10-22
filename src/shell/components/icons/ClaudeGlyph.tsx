import { Sparkles } from 'lucide-react';

// Source glyph for Claude Code entries (panel rows + banner). Inline
// so it sits before the title without changing the row layout.
export function ClaudeGlyph() {
  return (
    <span
      className="claude-glyph inline-flex align-[-2px] mr-1 text-[#c9a7ff]"
      title="Claude Code"
      aria-label="Claude Code"
    >
      <Sparkles size={12} />
    </span>
  );
}
