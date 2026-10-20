// Fake `gh` CLI for the Phase 6 pr-title fallback e2e
// (AGENT_WORKSPACE_TEST_GH_CMD → `node out/fixtures/fakeGh.cjs`).
// `pr view <url> --json state,isDraft,title` → prints FAKE_GH_JSON verbatim;
// anything else exits 1.
const argv = process.argv.slice(2);
if (argv[0] === 'pr' && argv[1] === 'view') {
  process.stdout.write(process.env.FAKE_GH_JSON ?? '{}');
} else {
  process.stderr.write('unsupported\n');
  process.exit(1);
}
