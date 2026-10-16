/**
 * The kept TypeScript item pre-checks (docs/actors.md, "Pre-check deletion",
 * Kept): a FIXED list of the 29 tools that still carry one, each with its
 * reason. A new tool relies on the database checks and never adds one, so a
 * slug that is not here fails, whatever the scoreboard pin says
 * (itemPrecheckTools in scripts/arch-scoreboard.pins.json). A slug goes from
 * this list when its reason does; nothing is ever added to it.
 */
import { describe, expect, it } from 'vitest';
import { MCP_SURFACE_POLICIES } from './mcp-surface-policies';
import { listBuiltins } from './registry';
import type { LegacyPrecheckReason } from './tool-policy';

const KEPT: Readonly<Record<string, LegacyPrecheckReason>> = Object.freeze({
  // A side effect lands before the statement the database checks.
  app_build: 'side-effect-before-check',
  app_db_schema_set: 'side-effect-before-check',
  app_db_seed: 'side-effect-before-check',
  app_delete: 'side-effect-before-check',
  app_snapshot_restore: 'side-effect-before-check',
  app_update: 'side-effect-before-check',
  file_delete: 'side-effect-before-check',
  journal_resolve_gap: 'side-effect-before-check',
  page_extract_section: 'side-effect-before-check',
  page_split: 'side-effect-before-check',
  tree_folder_delete: 'side-effect-before-check',
  tree_item_move: 'side-effect-before-check',
  // The database does not check the write.
  app_table_export_remove: 'db-does-not-check',
  app_table_export_set: 'db-does-not-check',
  content_supersede: 'db-does-not-check',
  // The write needs a read the database does not ask.
  app_duplicate: 'read-not-asked',
  app_export: 'read-not-asked',
  // The answer without it is worse.
  app_publish: 'answer-worse',
  node_share: 'answer-worse',
  page_block_append: 'answer-worse',
  page_block_delete: 'answer-worse',
  page_block_insert_after: 'answer-worse',
  page_block_insert_before: 'answer-worse',
  page_block_update: 'answer-worse',
  page_blocks_apply: 'answer-worse',
  page_from_file: 'answer-worse',
  page_from_note: 'answer-worse',
  page_from_notes: 'answer-worse',
  page_share: 'answer-worse',
});

describe('the kept item pre-checks (legacyItemPrecheck)', () => {
  it('only the fixed list carries one, each with its reason', () => {
    const now = Object.fromEntries(
      listBuiltins().flatMap((d) =>
        d.policy.legacyItemPrecheck ? [[d.slug, d.policy.legacyItemPrecheck.reason] as const] : [],
      ),
    );
    expect(now).toEqual(KEPT);
  });

  it('the list only shrinks: 29 at fix round A', () => {
    expect(Object.keys(KEPT).length).toBeLessThanOrEqual(29);
  });

  it('no hand-written MCP tool carries one', () => {
    expect(
      Object.entries(MCP_SURFACE_POLICIES).flatMap(([slug, p]) =>
        p.legacyItemPrecheck ? [slug] : [],
      ),
    ).toEqual([]);
  });
});
