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
import { eq } from 'drizzle-orm';
import {
  apps,
  db,
  foldersReadOf,
  itemWriteRefusalOf,
  scopeHoldsAdmin,
  type ItemNeed,
  type ItemWriteRefusal,
} from '@mantle/db';
import { currentWorkspaceScope } from '@mantle/db/viewer';
import { clampFilesFolderPath } from '@mantle/files';
import {
  builtinPolicy,
  type ToolItemResolver,
  type ToolItemTarget,
  type ToolPolicy,
} from './tool-policy';
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

/** The refusal, before a call is queued for approval, of a reference (a
 *  Recall map by its slug, a create's target folder by its path) the
 *  queuing scope does not read (A5 step 6a, carried round-2 LOW-1; worded
 *  in fix round 1, M1): it says what to name instead, never that the thing
 *  exists or where to look for it. */
export function refNotInScopeError(what: string, lookup: string): string {
  return `${what} is not one in your workspaces, so this call is not queued for approval: name one of yours (${lookup} lists them).`;
}

/** The ltree paths of the folders on `path` below its kind's root, the
 *  shortest first: files.a.b gives files.a and files.a.b. */
function folderPrefixes(path: string): string[] {
  const parts = path.split('.');
  const out: string[] = [];
  for (let n = 2; n <= parts.length; n += 1) out.push(parts.slice(0, n).join('.'));
  return out;
}

/**
 * Before a call is queued for approval (A5 step 6a, carried round-2 LOW-1):
 * a create whose target folder is named by its path (the policy's
 * `createsIn`) is asked of the queuing scope, in the item check's words.
 * The approved call runs in the approver's scope, which may read (and
 * create in) a folder this scope does not.
 *
 *  - A create that makes the missing folders of its path itself
 *    (`makesFolders`: file_create, fix round 1, M1) is asked of the
 *    deepest folder of the path, cut to the depth its handler cuts it to
 *    (clampFilesFolderPath), that the scope reads: one there, the create
 *    queues (a new subfolder of a folder of the scope's lands inside it,
 *    and dispatch asks the create again). None at all (only the kind's
 *    root, or folders it does not read), it is refused.
 *  - Any other create needs the folder itself, read by the scope.
 *
 * A path that is only a kind's root (`files`: one label, structure, not
 * content, read whatever the scope holds as upsertFile reads it) and a
 * scope that holds the Admin workspace (it queues for an approver of the
 * same workspace) are not asked. Outside a workspace scope nothing is
 * checked. Asked in the scope only (foldersReadOf): a folder it does not
 * read is never told apart from one that does not exist.
 */
export async function createFolderRefusal(
  param: string | undefined,
  input: Record<string, unknown>,
  ownerId: string,
  makesFolders = false,
): Promise<string | null> {
  if (!param) return null;
  const raw = typeof input[param] === 'string' ? input[param].trim() : '';
  if (!raw || !raw.includes('.')) return null;
  if (!currentWorkspaceScope()) return null;
  if (await scopeHoldsAdmin()) return null;
  const lookup = 'folder_list / tree_list';
  if (makesFolders && raw.startsWith('files.')) {
    const path = clampFilesFolderPath(raw);
    const read = await foldersReadOf(ownerId, folderPrefixes(path));
    if (read.size > 0) return null;
    return `No folder on the path ${path} is one in your workspaces, so this call is not queued for approval: put it in a folder of yours (${lookup} lists them).`;
  }
  const read = await foldersReadOf(ownerId, [raw]);
  return read.has(raw) ? null : refNotInScopeError(`Folder ${raw}`, lookup);
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

/** What a tool's write names (its policy's `items`): a target per argument,
 *  or a resolver. */
export type ToolItems = ToolPolicy['items'];

/**
 * The items the write tool a row names writes to, read from the policies:
 * the builtin the row's `slug` names, else its handler `ref`'s (a row may
 * rename a builtin). A5 step 6a deleted the ITEM_WRITE_TARGETS view. A
 * link (A0): opening or closing it needs edit of the item; an app's needs
 * manage, which assertMayLink asks once it knows the type (link-serve.ts);
 * closing one is the handler's own rule and the database's (link_close).
 * An app copy (appCopy) and the my_app_* tools check their own app.
 */
export function builtinItems(slug: string, ref?: string): ToolItems {
  return builtinPolicy(slug)?.items ?? (ref ? builtinPolicy(ref)?.items : undefined);
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
 * `items` is the tool's own policy's (builtinItems for a builtin row, a
 * definition's policy for an MCP tool). Run after the tool's
 * preconditions, so an id the scope cannot read gets the precondition's
 * teaching error first where the tool declares one.
 */
export async function toolItemWriteRefusal(
  items: ToolItems,
  input: Record<string, unknown>,
  ownerId: string,
  ctx?: Pick<ToolHandlerContext, 'surface'> & { queue?: boolean },
): Promise<string | null> {
  return (await toolItemWriteRefusalOf(items, input, ownerId, ctx))?.message ?? null;
}

/** toolItemWriteRefusal, with the edit check's detail of the refusal (A5
 *  step 4 fix round 2: a /api/v1 route answers it as the database's). */
export async function toolItemWriteRefusalOf(
  items: ToolItems,
  input: Record<string, unknown>,
  ownerId: string,
  ctx?: Pick<ToolHandlerContext, 'surface'> & { queue?: boolean },
): Promise<ItemWriteRefusal | null> {
  if (!currentWorkspaceScope()) return null;
  if (!items) return null;
  const sets: { ids: string[]; need: ItemNeed; unresolved?: string }[] =
    typeof items === 'function'
      ? await items(input, ownerId, ctx)
      : items.map((t) => ({ ids: idsOf(input[t.param]), need: t.need }));
  for (const set of sets) {
    // A reference that names nothing the scope reads, asked before a call
    // is queued (`unresolved`, A5 step 6a): the item check's not-in-scope.
    if (set.unresolved) return { message: set.unresolved, detail: 'no_read' };
    const refused = await itemWriteRefusalOf(set.ids, set.need);
    if (refused) return refused;
  }
  return null;
}
