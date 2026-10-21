// Fake CLI for the terminal E2E: prints a ready marker, enables bracketed
// paste (ESC[?2004h) like a real shell, prints the spawn args, then
// echoes stdin. Non-printable
// input bytes are escaped as \xNN because ConPTY output processing drops
// raw control bytes (e.g. a pasted ^V / ^C would be invisible otherwise).
const escape = (s: string) =>
  // eslint-disable-next-line no-control-regex -- escaping control bytes is the point
  s.replace(/[\x00-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
process.stdout.write('ready\n\x1b[?2004h');
process.stdout.write(`args:${process.argv.slice(2).join(' ')}\n`);
// Presence (not value) of injected env vars — the claude-hook token is a secret.
process.stdout.write(
  `env:AGENT_WORKSPACE_CLAUDE_HOOK_TOKEN=${process.env.AGENT_WORKSPACE_CLAUDE_HOOK_TOKEN ? 'set' : 'unset'}\n`,
);
process.stdin.on('data', (data: Buffer) => {
  process.stdout.write(`echo:${escape(data.toString())}`);
});
process.stdin.resume();
