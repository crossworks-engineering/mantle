/**
 * The MCP tool annotations (the "hints") of one registered tool, derived
 * from its policy. registerGatedTool (gated-tools.ts) passes them to the
 * SDK with the name, description and schema, so a client sees them in
 * tools/list. They are advisory: nothing on the brain side reads them, the
 * gate decides what runs exactly as before.
 *
 * Why: Claude Desktop and claude.ai offer "Always allow" only on a tool
 * that carries `readOnlyHint: true`. Without hints every tool looked like a
 * write, and a user had to approve every search again and again
 * (2026-10-28, a Teams account on a client box).
 *
 * The rules (dev-brain task b5bdb402):
 *
 *  - `title`: the slug.
 *  - `readOnlyHint`: true exactly when the policy's effect is `read`. The
 *    effect is declared on every builtin (tool-policy.ts: a read mutates
 *    nothing the owner owns and sends nothing out; default deny) and on
 *    every hand-written definition (mcp-surface-policies.ts). It is never
 *    derived from a name here.
 *  - `destructiveHint`: true only for a write that cannot be undone
 *    (DESTRUCTIVE_WRITES, each with why). A soft delete with an undelete,
 *    a draft edit a discard reverts, a restore that keeps what it replaces:
 *    false.
 *  - `idempotentHint`: true for a read and for a write documented as an
 *    upsert, a set, a mark or a no-op when already so (IDEMPOTENT_WRITES).
 *  - `openWorldHint`: true for a tool that reaches outside the brain: its
 *    policy says it reaches out (`outside.egress`: the web tools, the mail
 *    and Telegram sends, a peer call), it is a linked-brain (peer) tool, or
 *    it is a connector row. False for the rest.
 *
 * A connector row (an MCP or OpenAPI connector's tool, a Toolsmith tool)
 * gets hints only when an admin confirmed it only reads (its policy's
 * effect is then `read`, external-access.ts). Unmarked, its effect is the
 * default-deny `write`, which says nothing about the tool: no hints at all
 * rather than a guess.
 */
import type { GatePolicy } from '@mantle/db';
import type { McpToolEntry } from './gated-tools';

/** The five hints the SDK's ToolAnnotations carries (SDK 2.4.0). */
export type ToolHints = Readonly<{
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}>;

/**
 * A write that cannot be undone, by the tool's own description. Kept out,
 * and why: app_delete (app_undelete, 30 days), app_file_delete (a draft
 * file; the last published version restores it), app_table_export_remove
 * (app_table_export_set re-creates the link), model_pool_remove (re-add),
 * content_supersede (`clear: true`), recall_card_delete
 * (recall_revision_restore), tree_folder_delete and folder_delete (nothing
 * inside is deleted; an empty folder only), page_block_delete,
 * table_column_delete, table_row_delete and table_tab_delete (the DRAFT,
 * a discard reverts), node_unshare and page_unshare (share again),
 * table_snapshot_restore, app_snapshot_restore, present_restore and
 * recall_revision_restore (each keeps what it replaces).
 */
export const DESTRUCTIVE_WRITES: ReadonlySet<string> = new Set([
  'api_tool_delete', // the user-defined tool row is gone
  'app_data_write', // a raw DELETE or REPLACE on an app's live rows
  'app_db_schema_set', // a free-form DDL script on the app's live database (DROP is not blocked)
  'app_snapshot_delete', // "Irreversible"
  'contact_delete', // the contact and its email allowlist entry are gone
  'event_delete', // the original id and its deeplinks are gone
  'file_create', // "Create or overwrite": the old bytes are gone
  'file_delete', // the row and the on-disk file are removed
  'file_upload', // "Create or overwrite": the old bytes are gone
  'formula_delete', // "Not reversible"
  'journal_delete', // the entry is gone
  'note_delete', // the note is gone
  'page_delete', // "irreversible"
  'page_discard_draft', // the draft "cannot be undone"
  'present_delete', // "Not reversible"
  'recall_map_delete', // "cannot be undone"
  'run_terminal', // a free-form shell on the brain's host
  'sandbox_exec', // a free-form shell in the sandbox
  'sandbox_rm', // the container goes; `purge_files` is irreversible
  'table_delete', // "Irreversible"
  'table_snapshot_delete', // "cannot be restored after"
  'task_delete', // the task is gone
]);

/** A write documented as an upsert, a set, a mark, or a no-op when already
 *  so: calling it again with the same arguments changes nothing more. */
export const IDEMPOTENT_WRITES: ReadonlySet<string> = new Set([
  'api_docs_set', // "Store (or REPLACE)"
  'api_skill_set', // "Write (or replace)"
  'app_source_set', // "Replace the app's ENTIRE draft source tree"
  'app_table_export_set', // "Create (or refresh)"
  'app_tools_set', // "Replaces the current list"
  'file_create', // "Create or overwrite"
  'file_upload', // "Create or overwrite"
  'messenger_mark_read', // the cursor only moves forward
  'model_pool_set', // "Upsert one model"
  'node_unshare', // "No-op (still succeeds) if it wasn't shared"
  'page_discard_draft', // "Idempotent"
  'page_unshare', // "No-op (still succeeds) if the page wasn't shared"
  'recall_card_put', // "Create or replace one card"
  'sandbox_autostart', // stores the one command
  'set_timezone', // sets the one value
  'table_cell_set', // sets the one cell
  'table_rows_upsert', // "Merge MANY rows ... ADDED ... UPDATED"
  'telegram_mark_processed', // a mark
  'tool_group_ensure', // "Create ... if it doesn't exist, or update"
  'worker_group_ensure', // "Idempotent upsert"
]);

/** A linked-brain (peer) tool: every one reaches the other brain, the
 *  reads too (their policies carry `untrusted`, not `egress`:
 *  docs/actors.md says why a peer read is not an egress). */
const PEER_PREFIX = 'peer_';

/** The slug the entry registers and is called by. */
function nameOf(entry: McpToolEntry): string {
  if (entry.kind === 'builtin') return entry.def.slug;
  if (entry.kind === 'connector') return entry.row.slug;
  return entry.name;
}

/** Whether the policy says the tool reaches outside the brain. */
function reachesOut(name: string, policy: GatePolicy): boolean {
  const outside = policy.fields?.outside;
  if (typeof outside === 'object' && outside !== null) {
    if ((outside as { egress?: unknown }).egress === true) return true;
  }
  return name.startsWith(PEER_PREFIX);
}

/**
 * The hints of `entry` under `policy`, or undefined for no hints: a
 * connector row an admin has not confirmed read-only, or no policy.
 */
export function toolAnnotations(
  entry: McpToolEntry,
  policy: GatePolicy | null | undefined,
): ToolHints | undefined {
  if (!policy) return undefined;
  const name = nameOf(entry);
  const read = policy.effect === 'read';
  if (entry.kind === 'connector') {
    if (!read) return undefined;
    return Object.freeze({
      title: name,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
  }
  return Object.freeze({
    title: name,
    readOnlyHint: read,
    destructiveHint: !read && DESTRUCTIVE_WRITES.has(name),
    idempotentHint: read || IDEMPOTENT_WRITES.has(name),
    openWorldHint: reachesOut(name, policy),
  });
}
