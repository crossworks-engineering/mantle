/**
 * The MCP tool annotations (the "hints") of one registered tool, derived
 * from its policy. registerGatedTool (gated-tools.ts) passes them to the
 * SDK with the name, description and schema, so a client sees them in
 * tools/list. They are advisory: nothing on the brain side reads them, the
 * gate decides what runs exactly as before.
 *
 * Why: Claude Desktop and claude.ai offer "Always allow" only on a tool
 * that carries `readOnlyHint: true`. Without hints every tool looked like a
 * write, and a user had to approve every search again and again.
 *
 * The rules. Every fact is DECLARED on the tool's policy (@mantle/tools
 * tool-policy.ts; the hand-written MCP definitions' in
 * mcp-surface-policies.ts), never derived from a name here (access policy
 * is not a list of slugs):
 *
 *  - `title`: the slug.
 *  - `readOnlyHint`: true exactly when the policy's `effect` is `read` (a
 *    read mutates nothing the owner owns and sends nothing out; default
 *    deny, so a write is `write`).
 *  - `destructiveHint`: true only for a write whose policy says
 *    `destructive`: it destroys stored data nothing keeps (a hard delete,
 *    a free-form shell, a replace of a whole stored body, list or file
 *    with no revision). False means "additive, or what it replaces is
 *    kept" (the MCP meaning), not "harmless": a send cannot be unsent,
 *    yet it destroys nothing. Kept unset, and why: app_delete
 *    (app_undelete, 30 days), app_file_delete and app_file_write (a draft
 *    file; the last published version restores it), app_table_export_remove
 *    (app_table_export_set re-creates the link), model_pool_remove
 *    (re-add), content_supersede (`clear: true`), recall_card_delete and
 *    recall_map_update (recall_revision_restore), present_update (ten
 *    versions kept), tree_folder_delete and folder_delete (nothing inside
 *    is deleted; an empty folder only), page_block_delete,
 *    table_column_delete, table_row_delete and table_tab_delete (the
 *    DRAFT, a discard reverts), node_unshare and page_unshare (share
 *    again), table_snapshot_restore, app_snapshot_restore, present_restore
 *    and recall_revision_restore (each keeps what it replaces).
 *  - `idempotentHint`: true for a read, and for a write whose policy says
 *    `idempotent` (documented as an upsert, a set, a mark, or a no-op when
 *    already so).
 *  - `openWorldHint`: true for a tool whose policy says it reaches outside
 *    the brain: `outside.egress` (the web tools, the mail and Telegram
 *    sends, a peer call) or `outside.via` of `web`, `http`, `send` or
 *    `peer` (every linked-brain tool, the reads too: docs/actors.md says
 *    why a peer read is not an egress; the OpenRouter and Mapbox fetches;
 *    a Telegram edit or reaction; a user-defined tool's test run), and
 *    for every connector row. The brain's own model providers are not an
 *    open world (a closed domain the owner configured). False for the
 *    rest.
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

/** The slug the entry registers and is called by. */
function nameOf(entry: McpToolEntry): string {
  if (entry.kind === 'builtin') return entry.def.slug;
  if (entry.kind === 'connector') return entry.row.slug;
  return entry.name;
}

/** The policy's `fields` bag (toGatePolicy carries the tool's `outside`,
 *  `destructive` and `idempotent` there), or nothing. */
function fieldsOf(policy: GatePolicy): Readonly<Record<string, unknown>> {
  return policy.fields ?? {};
}

/** The `outside.via` values that reach an open world (ToolOutside): a
 *  web page, a third-party HTTP API, a send to a person, a linked brain.
 *  Not `shell` (the brain's own host), `sandbox` (its container), `link`
 *  or `publish` (a share of the brain's own content). */
const OPEN_VIAS: ReadonlySet<unknown> = new Set(['web', 'http', 'send', 'peer']);

/** Whether the policy says the tool reaches outside the brain. */
function reachesOut(policy: GatePolicy): boolean {
  const outside = fieldsOf(policy).outside;
  if (typeof outside !== 'object' || outside === null) return false;
  const o = outside as { egress?: unknown; via?: unknown };
  return o.egress === true || OPEN_VIAS.has(o.via);
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
  const fields = fieldsOf(policy);
  return Object.freeze({
    title: name,
    readOnlyHint: read,
    destructiveHint: !read && fields.destructive === true,
    idempotentHint: read || fields.idempotent === true,
    openWorldHint: reachesOut(policy),
  });
}
