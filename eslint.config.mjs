// ESLint flat config. Deliberately minimal: @eslint/js recommended +
// typescript-eslint recommended (not the type-checked variants — keeps `npm run
// lint` fast and independent of tsc) + react-hooks for the shell. No stylistic
// rules (Prettier is not adopted).
//
// typescript-eslint is imported through tools/lint/ (see tools/lint/package.json)
// because the root's typescript@7 has no JS compiler API.
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from './tools/lint/typescript-eslint.mjs';

export default tseslint.config(
  {
    ignores: [
      'out/',
      'dist/',
      'node_modules/',
      'docs/',
      'test-results/',
      'playwright-report/',
      'tools/',
      '**/*.cjs',
      // TODO(phase7b): lint once Phase 6 lands — these files are being edited
      // concurrently by Phase 6 (host.ts: 5 unused vars; ClaudeSidebar.tsx:
      // 2 exhaustive-deps + 1 purity; claudeTranslate.ts: 1 control-regex).
      'src/main/claude/host.ts',
      'src/shell/components/ClaudeSidebar.tsx',
      'src/core/claudeTranslate.ts',
      // Also Phase 6: 4 unused vars, and 12 no-useless-escape on the
      // `'C:\work\alpha'` literals — those need a behaviour decision (the
      // un-escaped string is 'C:workalpha' today), not a lint-pass edit.
      'tests/e2e/claudeHooks.spec.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // IPC bridges, test hooks and fixtures work on untyped payloads.
      '@typescript-eslint/no-explicit-any': 'off',
      // Non-null assertions are used deliberately after runtime guards.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // `catch {}` is the idiom for best-effort cleanup (fs, IPC, timers).
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Flags `let x: T = null; try { x = … }` — the initialiser documents the
      // type before a try/catch; rewriting those is not a lint-pass change.
      'no-useless-assignment': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: ['src/shell/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // React Compiler rule (react-hooks v7). The shell does not use the
      // compiler and its "reset local state when a prop changes" effects are
      // the documented pre-compiler pattern; fixing them is a refactor, not a
      // lint-pass change. Revisit if the compiler is adopted.
      'react-hooks/set-state-in-effect': 'off',
    },
  },
);
