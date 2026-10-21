import { defineConfig } from '@playwright/test';

// Installed-artifact smoke. Not part of `npm run test:e2e`; driven by
// scripts/smoke-install.ps1 which sets AGENT_WORKSPACE_INSTALLED_EXE.
export default defineConfig({
  testDir: './tests/smoke',
  testMatch: '**/*.spec.ts',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: 'line',
});
