/**
 * The edit check of a tool's write to an item (workspaces W7a fix round 1,
 * M2). An Admin turn and an Admin login's MCP call write on the system pool
 * with no scope on the statement (a typed write in a scope, @mantle/db
 * client.ts), so the database's own checks (moves, creates in a folder and
 * deletes, under withSystemTx) never saw a content edit. Every write tool
 * that names an item is listed here with what it needs of that item, and
 * the dispatcher (dispatch.ts) and the owner MCP bridge
 * (@mantle/mcp-core register/context.ts) ask the scope before the handler
 * runs: the same rule as the item routes since W6a (mantle_may_edit for a
 * content change, mantle_may_manage for a delete, a move or a link, a read
 * for a write that only needs to see the item; a read-only snapshot copy is
 * never edited). @mantle/db item-rights.ts holds the check.
 *
 * A create names no item (its folder's create check is the database's).
 * Outside a workspace scope nothing is checked: the surface rules decide.
 */
import { and, eq } from 'drizzle-orm';
import {
  apps,
  currentGateScope,
  db,
  itemWriteRefusal,
  withTurnScope,
  recallMaps,
  recallRevisions,
  type ItemNeed,
} from '@mantle/db';
import { currentWorkspaceScope } from '@mantle/db/viewer';
import { mapRef } from './builtins-recall-write';
import { callerHasArea } from './admin-gate';

/** One item a write names: the argument holding its id (a list for an
 *  array argument) and what the write needs of it. */
type Target = { param: string; need: ItemNeed };
/** The targets of one call, worked out from its input (a recall map named by
 *  its slug, a move that only sometimes moves). */
type Resolver = (
  input: Record<string, unknown>,
  ownerId: string,
) => Promise<{ ids: string[]; need: ItemNeed }[]>;

const edit = (param: string): Target => ({ param, need: 'edit' });
const manage = (param: string): Target => ({ param, need: 'manage' });
const read = (param: string): Target => ({ param, need: 'read' });

/** Closing a link: edit of the item, or the users area (an Admin user may
 *  close any link of the brain; closing only narrows). */
const closeLinkTargets: Resolver = async (input) => {
  if (await callerHasArea('users')) return [];
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  return id ? [{ ids: [id], need: 'edit' }] : [];
};

/** A recall map, by slug, former slug or id, as the recall tools take it. */
const recallMap =
  (need: ItemNeed): Resolver =>
  async (input, ownerId) => {
    const ref = typeof input.map === 'string' ? input.map.trim() : '';
    if (!ref) return [];
    // Resolved in the scope: a map it does not read is the tool's own "not
    // found" (its lookup runs in the same scope).
    const map = await mapRef(ownerId, ref);
    return map ? [{ ids: [map.id], need }] : [];
  };

/**
 * A copy of an app (app_duplicate, app_export; W7 integration fix 2, M3):
 * the code needs a read of the app, its data (with_data, on by default) the
 * whole SQLite database every holder shares, so an edit right on the app,
 * unless the app's MCP access switch opens its data to every reader's own
 * connection anyway. An app the scope cannot see needs the edit (fail
 * closed).
 */
const appCopy: Resolver = async (input) => {
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  if (!id) return [];
  if (input.with_data === false) return [{ ids: [id], need: 'read' }];
  const [row] = /^[0-9a-f-]{36}$/i.test(id)
    ? await db.select({ mcp: apps.mcpAccess }).from(apps).where(eq(apps.nodeId, id)).limit(1)
    : [];
  return [{ ids: [id], need: row?.mcp ? 'read' : 'edit' }];
};

/** The write tools that name an item, by slug (and by a builtin's ref). */
export const ITEM_WRITE_TARGETS: ReadonlyMap<string, readonly Target[] | Resolver> = new Map<
  string,
  readonly Target[] | Resolver
>([
  // Files and folders.
  ['file_rename', [edit('file_id')]],
  ['file_set_indexing', [edit('file_id')]],
  ['file_move', [manage('file_id')]],
  ['file_delete', [manage('file_id')]],
  ['folder_rename', [edit('folder_id')]],
  ['folder_describe', [edit('folder_id')]],
  ['folder_set_indexing', [edit('folder_id')]],
  ['folder_move', [manage('folder_id')]],
  ['folder_delete', [manage('folder_id')]],
  ['tree_folder_delete', [manage('folder_id')]],
  [
    'tree_folder_update',
    async (input) => {
      const id = typeof input.folder_id === 'string' ? input.folder_id : '';
      // A new parent moves the folder: Moderators of its home only.
      return id ? [{ ids: [id], need: input.parent_id !== undefined ? 'manage' : 'edit' }] : [];
    },
  ],
  ['tree_item_move', [manage('item_ids')]],
  // Pages.
  ['page_update', [edit('id')]],
  ['page_update_draft', [edit('id')]],
  ['page_commit', [edit('id')]],
  ['page_discard_draft', [edit('id')]],
  ['page_block_update', [edit('page_id')]],
  ['page_block_insert_after', [edit('page_id')]],
  ['page_block_insert_before', [edit('page_id')]],
  ['page_block_append', [edit('page_id')]],
  ['page_block_delete', [edit('page_id')]],
  ['page_blocks_apply', [edit('page_id')]],
  ['page_split', [edit('page_id')]],
  ['page_extract_section', [edit('page_id')]],
  ['page_mention', [edit('page_id')]],
  ['page_replace_from_file', [edit('page_id')]],
  ['page_move', [manage('id')]],
  ['page_delete', [manage('id')]],
  // A link (docs/workspaces.md, A0): opening or closing it needs edit of
  // the item; an app's needs manage, which assertMayLink asks once it knows
  // the type (link-serve.ts). An Admin user with the users area may close
  // any link: the handler checks the item, or that area, itself.
  ['page_share', [edit('id')]],
  ['page_unshare', closeLinkTargets],
  ['node_share', [edit('id')]],
  ['node_unshare', closeLinkTargets],
  // A conversion that retires its source edits the source. The handlers
  // retire it unless supersede_source is false (pages/from.ts): an omitted
  // flag retires too (W7a fix round 2, N2).
  [
    'page_from_note',
    async (input) =>
      input.supersede_source !== false && typeof input.note_id === 'string'
        ? [{ ids: [input.note_id], need: 'edit' }]
        : [],
  ],
  [
    'page_from_file',
    async (input) =>
      input.supersede_source !== false && typeof input.file_id === 'string'
        ? [{ ids: [input.file_id], need: 'edit' }]
        : [],
  ],
  [
    'page_from_notes',
    async (input) =>
      input.supersede_source !== false && Array.isArray(input.note_ids)
        ? [{ ids: input.note_ids.filter((i): i is string => typeof i === 'string'), need: 'edit' }]
        : [],
  ],
  // Notes, tasks, events, contacts, journal, formulas.
  ['note_update', [edit('id')]],
  ['note_delete', [manage('id')]],
  ['task_update', [edit('id')]],
  ['task_delete', [manage('id')]],
  ['event_update', [edit('id')]],
  ['event_delete', [manage('id')]],
  ['contact_update', [edit('id')]],
  ['contact_delete', [manage('id')]],
  ['journal_update', [edit('id')]],
  ['journal_resolve_gap', [edit('id')]],
  ['journal_delete', [manage('id')]],
  ['formula_update', [edit('id')]],
  ['formula_delete', [manage('id')]],
  // Tables.
  ['table_update', [edit('id')]],
  ['table_commit', [edit('id')]],
  ['table_delete', [manage('id')]],
  ['table_snapshot_create', [edit('id')]],
  ['table_snapshot_restore', [edit('id')]],
  ['table_snapshot_delete', [edit('id')]],
  ['table_row_add', [edit('table_id')]],
  ['table_rows_add', [edit('table_id')]],
  ['table_rows_upsert', [edit('table_id')]],
  ['table_row_update', [edit('table_id')]],
  ['table_row_delete', [edit('table_id')]],
  ['table_cell_set', [edit('table_id')]],
  ['table_column_add', [edit('table_id')]],
  ['table_column_update', [edit('table_id')]],
  ['table_column_delete', [edit('table_id')]],
  ['table_tab_add', [edit('table_id')]],
  ['table_tab_rename', [edit('table_id')]],
  ['table_tab_delete', [edit('table_id')]],
  ['table_set_aggregate', [edit('table_id')]],
  ['table_set_view', [edit('table_id')]],
  // Apps (the owner's app tools; the my_app_* tools check their own app).
  ['app_update', [edit('id')]],
  ['app_file_write', [edit('id')]],
  ['app_file_delete', [edit('id')]],
  ['app_source_set', [edit('id')]],
  ['app_build', [edit('id')]],
  ['app_tools_set', [edit('id')]],
  ['app_db_schema_set', [edit('id')]],
  ['app_db_seed', [edit('id')]],
  ['app_table_export_set', [edit('id')]],
  ['app_table_export_remove', [edit('id')]],
  ['app_publish', [edit('id')]],
  ['app_snapshot_create', [edit('id')]],
  ['app_snapshot_restore', [edit('id')]],
  ['app_snapshot_delete', [edit('id')]],
  ['app_delete', [manage('id')]],
  ['app_duplicate', appCopy],
  ['app_export', appCopy],
  // Recall maps (named by slug or id).
  ['recall_map_update', recallMap('edit')],
  ['recall_card_put', recallMap('edit')],
  ['recall_card_delete', recallMap('edit')],
  ['recall_cards_reorder', recallMap('edit')],
  ['recall_card_set_slug', recallMap('edit')],
  ['recall_map_set_slug', recallMap('edit')],
  ['recall_prompt_confirm', recallMap('edit')],
  ['recall_map_publish', recallMap('edit')],
  ['recall_map_delete', recallMap('manage')],
  [
    'recall_revision_restore',
    async (input, ownerId) => {
      const id = typeof input.revision_id === 'string' ? input.revision_id.trim() : '';
      if (!/^[0-9a-f-]{36}$/i.test(id)) return [];
      const [row] = await db
        .select({ node: recallMaps.nodeId })
        .from(recallRevisions)
        .innerJoin(recallMaps, eq(recallMaps.id, recallRevisions.mapId))
        .where(and(eq(recallRevisions.id, id), eq(recallMaps.ownerId, ownerId)))
        .limit(1);
      return row?.node ? [{ ids: [row.node], need: 'edit' }] : [];
    },
  ],
  // Any item: supersession, its access, its extraction (a read: L1).
  ['content_supersede', [edit('node_id')]],
  ['access_set', [manage('node_id')]],
  ['process_extraction', [read('node_id')]],
]);

/** The targets a tool's `slug` (or its builtin `ref`) lists, if any. */
export function itemWriteTargetsOf(
  slug: string,
  ref?: string,
): readonly Target[] | Resolver | null {
  return ITEM_WRITE_TARGETS.get(slug) ?? (ref ? (ITEM_WRITE_TARGETS.get(ref) ?? null) : null);
}

/** The ids an argument holds: one id, or a list of them. */
function idsOf(v: unknown): string[] {
  if (typeof v === 'string') return v.trim() ? [v] : [];
  if (Array.isArray(v)) return v.filter((i): i is string => typeof i === 'string');
  return [];
}

/**
 * Why the current workspace scope may not make this call's write, or null
 * (no workspace scope, a tool that names no item, or a write it may make).
 * Run after the tool's preconditions, so an id the scope cannot read gets
 * the precondition's teaching error first where the tool declares one.
 */
export async function toolItemWriteRefusal(
  slug: string,
  input: Record<string, unknown>,
  ownerId: string,
  ref?: string,
): Promise<string | null> {
  if (!currentWorkspaceScope()) {
    // Under the rollback switch the login's own scope answers the check
    // (W7 integration fix 2, M6): the switch restores only the read path.
    const g = currentGateScope();
    if (!g) return null;
    return withTurnScope(g, () => toolItemWriteRefusal(slug, input, ownerId, ref));
  }
  const targets = itemWriteTargetsOf(slug, ref);
  if (!targets) return null;
  const sets =
    typeof targets === 'function'
      ? await targets(input, ownerId)
      : targets.map((t) => ({ ids: idsOf(input[t.param]), need: t.need }));
  for (const set of sets) {
    const refused = await itemWriteRefusal(set.ids, set.need);
    if (refused) return refused;
  }
  return null;
}
