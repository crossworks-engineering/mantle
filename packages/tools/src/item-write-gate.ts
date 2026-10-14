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
 * content change or a link, mantle_may_manage for a delete or a move, a read
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
  itemWriteRefusalOf,
  withTurnScope,
  recallMaps,
  recallRevisions,
  type ItemNeed,
  type ItemWriteRefusal,
} from '@mantle/db';
import { currentWorkspaceScope } from '@mantle/db/viewer';
import { callerHasArea, callerScope } from './admin-gate';
import { policySlugMap, type ToolItemResolver, type ToolItemTarget } from './tool-policy';
import { keyOrPeerVia } from './surface';
import type { ToolHandlerContext } from './types';

/** One item a write names: the argument holding its id (a list for an
 *  array argument) and what the write needs of it. */
type Target = ToolItemTarget;
/** The targets of one call, worked out from its input (a recall map named by
 *  its slug, a move that only sometimes moves). */
type Resolver = ToolItemResolver;

// What a tool's policy names as its `items` (tool-policy.ts): a target per
// argument, or one of the resolvers below. A builtin's definition imports
// them, so this module imports no builtin.

/** The item in `param` needs an edit right. */
export function edit(param: string): Target {
  return { param, need: 'edit' };
}
/** The item in `param` needs a manage right (a move, a delete). */
export function manage(param: string): Target {
  return { param, need: 'manage' };
}
/** The item in `param` needs to be readable. */
export function read(param: string): Target {
  return { param, need: 'read' };
}

/** Closing a link: edit of the item, or the users area (an Admin user may
 *  close any link of the brain; closing only narrows). */
export const closeLinkTargets: Resolver = async (input, _ownerId, ctx) => {
  // Only in a workspace scope (callerHasArea says yes outside any), never
  // for an API key or a linked brain, as node_unshare's own check (A0 fix
  // rounds 2 and 3, L-4, L-e).
  if (ctx && !keyOrPeerVia(ctx) && callerScope() && (await callerHasArea('users'))) return [];
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  return id ? [{ ids: [id], need: 'edit' }] : [];
};

/** A recall map, by slug, former slug or id, as the recall tools take it. */
export function recallMap(need: ItemNeed): Resolver {
  return async (input, ownerId) => {
    const ref = typeof input.map === 'string' ? input.map.trim() : '';
    if (!ref) return [];
    // Resolved in the scope: a map it does not read is the tool's own "not
    // found" (its lookup runs in the same scope). Imported at the call: the
    // recall tools' module defines builtins, which import this one.
    const { mapRef } = await import('./builtins-recall-write');
    const map = await mapRef(ownerId, ref);
    return map ? [{ ids: [map.id], need }] : [];
  };
}

/**
 * A copy of an app (app_duplicate, app_export; W7 integration fix 2, M3):
 * the code needs a read of the app, its data (with_data, on by default) the
 * whole SQLite database every holder shares, so an edit right on the app,
 * unless the app's MCP access switch opens its data to every reader's own
 * connection anyway. An app the scope cannot see needs the edit (fail
 * closed).
 */
export const appCopy: Resolver = async (input) => {
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  if (!id) return [];
  if (input.with_data === false) return [{ ids: [id], need: 'read' }];
  const [row] = /^[0-9a-f-]{36}$/i.test(id)
    ? await db.select({ mcp: apps.mcpAccess }).from(apps).where(eq(apps.nodeId, id)).limit(1)
    : [];
  return [{ ids: [id], need: row?.mcp ? 'read' : 'edit' }];
};

/** A folder update: a new parent moves the folder (Moderators of its home
 *  only), anything else edits it. */
export const treeFolderUpdateTargets: Resolver = async (input) => {
  const id = typeof input.folder_id === 'string' ? input.folder_id : '';
  // A new parent moves the folder: Moderators of its home only.
  return id ? [{ ids: [id], need: input.parent_id !== undefined ? 'manage' : 'edit' }] : [];
};

// A conversion that retires its source edits the source. The handlers
// retire it unless supersede_source is false (pages/from.ts): an omitted
// flag retires too (W7a fix round 2, N2).

/** page_from_note's source note. */
export const pageFromNoteSource: Resolver = async (input) =>
  input.supersede_source !== false && typeof input.note_id === 'string'
    ? [{ ids: [input.note_id], need: 'edit' }]
    : [];

/** page_from_file's source file. */
export const pageFromFileSource: Resolver = async (input) =>
  input.supersede_source !== false && typeof input.file_id === 'string'
    ? [{ ids: [input.file_id], need: 'edit' }]
    : [];

/** page_from_notes' source notes. */
export const pageFromNotesSources: Resolver = async (input) =>
  input.supersede_source !== false && Array.isArray(input.note_ids)
    ? [{ ids: input.note_ids.filter((i): i is string => typeof i === 'string'), need: 'edit' }]
    : [];

/** A recall revision's map. */
export const recallRevisionTargets: Resolver = async (input, ownerId) => {
  const id = typeof input.revision_id === 'string' ? input.revision_id.trim() : '';
  if (!/^[0-9a-f-]{36}$/i.test(id)) return [];
  const [row] = await db
    .select({ node: recallMaps.nodeId })
    .from(recallRevisions)
    .innerJoin(recallMaps, eq(recallMaps.id, recallRevisions.mapId))
    .where(and(eq(recallRevisions.id, id), eq(recallMaps.ownerId, ownerId)))
    .limit(1);
  return row?.node ? [{ ids: [row.node], need: 'edit' }] : [];
};

/**
 * The write tools that name an item, by slug (and by a builtin's ref): a
 * view of each builtin's `policy.items` (tool-policy.ts). A link (A0):
 * opening or closing it needs edit of the item; an app's needs manage, which
 * assertMayLink asks once it knows the type (link-serve.ts); an Admin user
 * with the users area may close any link (closeLinkTargets). An app copy
 * (appCopy) and the my_app_* tools check their own app.
 */
export const ITEM_WRITE_TARGETS: ReadonlyMap<string, readonly Target[] | Resolver> = policySlugMap(
  (p) => p.items,
);

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
  ctx?: Pick<ToolHandlerContext, 'surface'>,
): Promise<string | null> {
  return (await toolItemWriteRefusalOf(slug, input, ownerId, ref, ctx))?.message ?? null;
}

/** toolItemWriteRefusal, with the edit check's detail of the refusal (A5
 *  step 4 fix round 2: a /api/v1 route answers it as the database's). */
export async function toolItemWriteRefusalOf(
  slug: string,
  input: Record<string, unknown>,
  ownerId: string,
  ref?: string,
  ctx?: Pick<ToolHandlerContext, 'surface'>,
): Promise<ItemWriteRefusal | null> {
  if (!currentWorkspaceScope()) {
    // Under the rollback switch the login's own scope answers the check
    // (W7 integration fix 2, M6): the switch restores only the read path.
    const g = currentGateScope();
    if (!g) return null;
    return withTurnScope(g, () => toolItemWriteRefusalOf(slug, input, ownerId, ref, ctx));
  }
  const targets = itemWriteTargetsOf(slug, ref);
  if (!targets) return null;
  const sets =
    typeof targets === 'function'
      ? await targets(input, ownerId, ctx)
      : targets.map((t) => ({ ids: idsOf(input[t.param]), need: t.need }));
  for (const set of sets) {
    const refused = await itemWriteRefusalOf(set.ids, set.need);
    if (refused) return refused;
  }
  return null;
}
