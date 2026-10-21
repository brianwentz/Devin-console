// Stand-in for `devin auth status` (AGENT_WORKSPACE_TEST_AUTH_STATUS_CMD).
// FAKE_AUTH_STATUS_EXIT set and non-zero -> prints the unauthenticated message
// and exits with that code; otherwise prints the signed-in status block with
// FAKE_AUTH_STATUS_USER_ID / FAKE_AUTH_STATUS_ORG_ID (CRLF line endings).
const exitCode = Number(process.env.FAKE_AUTH_STATUS_EXIT ?? '0') || 0;
if (exitCode !== 0) {
  process.stdout.write("Not logged in. Run 'devin auth login'.\r\n");
  process.exit(exitCode);
}
const userId = process.env.FAKE_AUTH_STATUS_USER_ID ?? 'user-fixture';
const orgId = process.env.FAKE_AUTH_STATUS_ORG_ID ?? 'org-fixture';
process.stdout.write(
  'User:\r\n' +
    '  Name:              Fixture User\r\n' +
    '  Email:             fixture@example.com\r\n' +
    `  User ID:           ${userId}\r\n` +
    'Account:\r\n' +
    `  Primary org:       ${orgId}\r\n`,
);
