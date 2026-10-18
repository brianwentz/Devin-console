// Re-exported from this workspace so the root eslint.config.mjs resolves the
// typescript-eslint tree that npm nested under tools/lint/node_modules (next
// to typescript@5). Resolving 'typescript-eslint' from the repo root would miss
// it: the root only has typescript@7, whose npm package has no JS compiler API.
export { default } from 'typescript-eslint';
