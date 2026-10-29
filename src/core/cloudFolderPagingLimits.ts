// Devin Cloud sidebar folder-paging limits (Branch B + C1). Kept apart from
// cloudFolderPaging.ts so cloudAcp.ts can default its caps to them without an
// import cycle (cloudFolderPaging.ts imports cloudAcp.ts); re-exported there.
//
// Source: docs/evidence/cloud-acp-spike-folder-paging.json (S0, 2026-10-28) —
// `participated` (total 42) paged at pageSize 20 gave 20/20/2 top-level rows at
// rootsOffset 0/20/40 with no duplicates; the root with 41 direct children came
// back complete (hasMoreChildren false) at maxChildrenPerRoot >= 50.

/** Page-1 `maxRootsPerFolder` and the folder-page `pageSize`. */
export const PAGE_SIZE = 20;
/** `maxChildrenPerRoot` on page 1 and on folder pages (C1). */
export const CHILD_CAP = 200;
/** Folder pages per folder per list (2x for the one list after Show more). */
export const MAX_PAGES_PER_FOLDER = 100;
/** Folder pages per list, all folders together. */
export const MAX_PAGES_PER_LIST = 200;
/** Wall-clock budget for all folder pages of one list. */
export const PAGING_BUDGET_MS = 45_000;
/** Per-page timeout ceiling; the effective timeout is min(this, remaining budget). */
export const PAGE_TIMEOUT_MS = 20_000;
/** Every folder is re-paged from offset 0 at least this often (memo staleness bound). */
export const FULL_REPAGE_MS = 300_000;
