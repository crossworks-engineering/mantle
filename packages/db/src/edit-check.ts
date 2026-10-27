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
  parser_failures: ['server/api/src/agent/extract/parser-failures.ts'],
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

/** What the extractor writes about a file's bytes (mantle_node_extractor_keys,
 *  0281; `parser_failures` since 0337): the read-only snapshot copy's list
 *  (it may change on a copy) and the files' BYTE_DERIVED_DATA_KEYS. A part
 *  of NODE_DERIVED_KEYS. */
export const NODE_EXTRACTOR_KEYS: readonly string[] = [
  'extract_skipped',
  'extract_completed_at',
  'extract_incomplete',
  'indexing_applied',
  'summary',
  'summary_model',
  'summary_at',
  'entities',
  'text',
  'vision_model',
  'ocr',
  'native_pdf',
  'schemaDigest',
  'parser_failures',
];

/** The presentation keys of nodes.data (mantle_node_presentation_keys):
 *  a change of these alone needs edit of the item OR of its folder (a
 *  board drag, a sibling rebalance; plan 20.3). `tree_rank` is an item's
 *  place in its folder's custom order (0335, docs/folder-tree.md). */
export const NODE_PRESENTATION_KEYS: readonly string[] = ['rank', 'tree_rank'];

/**
 * Keys of nodes.data a user's own write sets, through one gateway only (A10
 * #7, the work stamp): not derived, since a non-system write sets them, so
 * the edit check lets them through. Each names the module that alone spells
 * the key (edit-check.test.ts holds every other product file to it), and
 * how it is set.
 */
export const GATEWAY_KEY_WRITERS: Readonly<Record<string, { module: string; how: string }>> = {
  index_work: {
    module: 'packages/db/src/index-work.ts',
    how: 'set via markContentChanged only (stampIndexWork, which @mantle/db does not export); read and dropped through the same module',
  },
  index_work_had_vector: {
    module: 'packages/db/src/index-work.ts',
    how: 'set with an embed stamp via markContentChanged only; dropped with the stamp',
  },
};

/**
 * Keys the extractor's files write that are NOT derived, each with why: a
 * user's own value the extractor copies or keeps (edit-check.test.ts reads
 * the extractor's key writes against both lists).
 */
export const EXTRACTOR_USER_KEYS: Readonly<Record<string, string>> = {
  sourceFileId:
    'a child item made from a file names its file (images.ts, auto-table.ts); the video tool sets it in a user turn too',
};
