/**
 * raw-write-allowlist (plan v3.2 section 3.2): the files whose raw write SQL
 * is not scoped code, so it stays raw. Each entry is pinned with its count
 * of sites and why; eslint-rules/no-raw-write-sql.mjs flags a file over its
 * pin, and eslint-rules/arch-lints.test.ts holds each count exact and the
 * list at RAW_WRITE_ALLOWLIST_CAP entries (plan rule 6). A new entry needs
 * a review line from the F auditor in its why.
 *
 * What may be here: the migrations and their runner, tests and test
 * support, systemWork modules and system-step.ts, the SQLite stores. Test
 * files and the migrations folder are not counted at all (isCounted), nor
 * test support (isTestSupport) and the hand-run harnesses
 * (cleanup-counts.mjs HAND_RUN_HARNESSES); system-step.ts and the SQLite stores
 * (packages/tabledb, the app DB runner) hold no raw write the rule reads,
 * so they need no entry.
 *
 * Each key stands on its own line as a quoted path followed by a colon:
 * cleanup-counts.mjs reads the keys from this text.
 */

/** @type {Record<string, { count: number, why: string }>} */
export const RAW_WRITE_ALLOWLIST = {
  'packages/db/src/migrate-runner.ts': {
    count: 2,
    why: 'the migration runner: each migration file runs as text, then its journal row, as system(migration)',
  },
  'server/web/lib/snapshot-copies.ts': {
    count: 3,
    why: 'a systemWork module: the boot step that makes snapshot copies under its advisory lock (system-work-allowlist.mjs)',
  },
};

/** The most entries the list may hold: its count (plan rule 6); it only
 *  goes down, and an entry past it is a review decision of the F auditor. */
export const RAW_WRITE_ALLOWLIST_CAP = 2;
