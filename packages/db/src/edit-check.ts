/**
 * The edit check (workspaces arch A3a, docs/edit-check.md): the keys of
 * nodes.data only the brain sets, and where each is written. The SQL list
 * is mantle_node_derived_keys() (migration 0281): edit-check.db.test.ts
 * holds the two equal, and edit-check.test.ts holds this inventory to the
 * code (each writer still writes its key; the extractor writes no key that
 * is not here or named as a user's).
 *
 * A non-system write (the write role) may clear one of these keys (an edit
 * invalidates what the brain derived from the old content: every content
 * edit drops the summary keys, a file overwrite drops the byte keys), never
 * set or change one.
 */

/** Each derived key and the files that write it (system work only). */
export const DERIVED_KEY_WRITERS: Readonly<Record<string, readonly string[]>> = {
  // The extractor.
  extract_skipped: [
    'server/api/src/agent/extract/terminal.ts',
    'packages/db/src/extract-skip-backfill.ts',
  ],
  extract_completed_at: ['server/api/src/agent/extractor.ts'],
  extract_incomplete: ['server/api/src/agent/extract/facts.ts'],
  extract_parked: ['server/api/src/agent/extract-heads-park.ts'],
  indexing_applied: ['server/api/src/agent/extract/gates.ts'],
  summary: ['server/api/src/agent/extract/index-writes.ts'],
  summary_model: ['server/api/src/agent/extract/index-writes.ts'],
  summary_at: ['server/api/src/agent/extract/index-writes.ts'],
  summary_folded: ['server/api/src/agent/extract/index-writes.ts'],
  entities: ['server/api/src/agent/extract/index-writes.ts'],
  text: ['server/api/src/agent/extract/index-writes.ts', 'server/api/src/agent/extract/images.ts'],
  vision_model: ['server/api/src/agent/extract/images.ts'],
  ocr: ['server/api/src/agent/extract/images.ts'],
  native_pdf: ['server/api/src/agent/extract/images.ts'],
  schemaDigest: ['server/api/src/agent/extract/index-writes.ts'],
  // The refold.
  refolded: [
    'server/api/src/agent/extract/gates.ts',
    'server/web/lib/maintenance/refold-embeds.ts',
  ],
  // Markers of system work: email sync, the app-nav backfills, the folds of
  // the personal spaces, a backfill script.
  emailAttachment: ['packages/email/src/sync.ts'],
  appNavMigratingAt: ['packages/content/src/tree/apps-nav.ts'],
  appNavMigratedAt: ['packages/content/src/tree/apps-nav.ts'],
  appMarksMigrated: ['packages/content/src/tree/apps-nav.ts'],
  trashedBeforeFold: ['packages/db/migrations/0267_workspaces_spaces_fold.sql'],
  trashedAt: ['packages/db/migrations/0267_workspaces_spaces_fold.sql'],
  space_file: ['packages/db/migrations/0267_workspaces_spaces_fold.sql'],
  salience_reason: ['server/web/scripts/backfill-email-salience.ts'],
};

/** The derived keys, as mantle_node_derived_keys() lists them. */
export const NODE_DERIVED_KEYS: readonly string[] = Object.keys(DERIVED_KEY_WRITERS);

/** The presentation keys of nodes.data (mantle_node_presentation_keys):
 *  a change of these alone needs edit of the item OR of its folder (a
 *  board drag, a sibling rebalance; plan 20.3). */
export const NODE_PRESENTATION_KEYS: readonly string[] = ['rank'];

/**
 * Keys the extractor's files write that are NOT derived, each with why: a
 * user's own value the extractor copies or keeps (edit-check.test.ts reads
 * the extractor's key writes against both lists).
 */
export const EXTRACTOR_USER_KEYS: Readonly<Record<string, string>> = {
  sourceFileId:
    'a child item made from a file names its file (images.ts, auto-table.ts); the video tool sets it in a user turn too',
};
