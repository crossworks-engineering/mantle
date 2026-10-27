/**
 * What the current workspace scope may do to items (workspaces W7a fix
 * round 1, M2): the one edit check of a write to an item made from a tool,
 * in a turn or on MCP, as the item routes ask it since W6a (the session's
 * item write gate): mantle_may_edit for a content change or a link,
 * mantle_may_manage for a delete or a move (an app's link: assertMayLink), a read for a write that only needs to see
 * the item. A read-only snapshot copy (data.snapshot_of) is never edited.
 *
 * A login's typed write in a scope runs on the write role in every check
 * mode (plan v3 S3), where the database checks it (gateway/write-route.ts,
 * the login write gateway), but only as the write runs: the tool asks it
 * here first, in the caller's scope, for a clear answer before any side
 * effect.
 *
 * Asked in the scope only: an item the scope does not read answers "not in
 * your workspaces", whether it exists or not, so no item's existence leaves
 * the scope. Outside a workspace scope (system work) nothing is checked:
 * the surface rules decide, as before.
 */
import { sql } from 'drizzle-orm';
import { db } from './client';
import { currentWorkspaceScope } from './viewer';
import { editCheckRefusalError, READ_ONLY_COPY_MESSAGE, UUID_RE } from '@mantle/std';
import { SnapshotCopyReadOnlyError } from './snapshot-copy';

/** What a write needs of an item. */
export type ItemNeed = 'read' | 'edit' | 'manage';

/** How an item check reads its need. `changes`: the write changes the item
 *  (a manage that writes it, an app's code or description), so a read-only
 *  snapshot copy is refused as an edit is, in the one read; a manage that
 *  only removes it (a delete) leaves it unset, as a copy's author may
 *  delete it. An edit always changes the item. */
export type ItemCheckOpts = Readonly<{ changes?: boolean }>;

/** The refusal of a write to an item the scope cannot read (W6a style). */
export function itemNotInScopeError(id: string): string {
  return `Item ${id} is not in your workspaces: it is in a workspace you are not in (add yourself to it first), or there is no such item (find it with search_nodes).`;
}

/** The refusal of a write the scope may read but not make. */
export function itemNoRightError(id: string, need: ItemNeed): string {
  return need === 'manage'
    ? `You cannot change this item in your workspaces (${id}): deleting or moving it is for a Moderator of its workspace.`
    : `You cannot change this item in your workspaces (${id}): ask for Write on it, or a Moderator of its workspace.`;
}

/** The refusal of an edit to a read-only snapshot copy. */
export const READ_ONLY_COPY_ERROR = READ_ONLY_COPY_MESSAGE;

/** What Postgres reads as a uuid besides the canonical form: braces, and a
 *  hyphen after any group of four digits, or none. */
const LOOSE_UUID_RE = /^\{?[0-9a-f]{4}(?:-?[0-9a-f]{4}){7}\}?$/i;

/** The refusal of an item id Postgres reads as a uuid that is not written in
 *  the canonical form (the check would not match it to its row). */
export function itemIdNotCanonicalError(id: string): string {
  return `Item id ${id} is not written as a uuid is: pass it as 8-4-4-4-12 hex digits with hyphens and no braces, as search_nodes returns it.`;
}

/**
 * Why the current scope may not do `need` to the items `ids`, or null when it
 * may (or when no workspace scope is active). An id that Postgres reads as a
 * uuid but is not canonical (no hyphens, braces) is refused, never dropped
 * (W7a fix round 2): the handler would cast it to the row the check never
 * saw. Any other id that is not a uuid is left to the tool's own error.
 */
export async function itemWriteRefusal(
  ids: readonly string[],
  need: ItemNeed,
): Promise<string | null> {
  return (await itemWriteRefusalOf(ids, need))?.message ?? null;
}

/** One refusal of itemWriteRefusalOf: its words, and the edit check's
 *  detail the database raises for the same write (no_read: the scope does
 *  not read the item; no_edit: it reads it but may not make the write, a
 *  read-only copy too), or null for an id the check cannot match (not
 *  canonical), which only its words answer. */
export type ItemWriteRefusal = Readonly<{
  message: string;
  detail: 'no_read' | 'no_edit' | null;
  /** An edit of a read-only snapshot copy (detail no_edit). */
  copy?: true;
}>;

/** itemWriteRefusal, with the edit check's detail (A5 step 4 fix round 2:
 *  a /api/v1 route answers the refusal as the database's, by its detail). */
export async function itemWriteRefusalOf(
  ids: readonly string[],
  need: ItemNeed,
  opts: ItemCheckOpts = {},
): Promise<ItemWriteRefusal | null> {
  if (!currentWorkspaceScope()) return null;
  const trimmed = ids.map((i) => i.trim().toLowerCase());
  const loose = trimmed.find((i) => !UUID_RE.test(i) && LOOSE_UUID_RE.test(i));
  if (loose !== undefined) return { message: itemIdNotCanonicalError(loose), detail: null };
  const list = [...new Set(trimmed.filter((i) => UUID_RE.test(i)))];
  if (list.length === 0) return null;
  const byId = await scopeRightsOf(list);
  for (const id of list) {
    const verdict = verdictOf(byId.get(id), need, need === 'edit' || opts.changes === true);
    if (verdict === 'no_read') return { message: itemNotInScopeError(id), detail: 'no_read' };
    if (verdict === 'copy') {
      return { message: READ_ONLY_COPY_ERROR, detail: 'no_edit', copy: true };
    }
    if (verdict === 'no_edit') return { message: itemNoRightError(id, need), detail: 'no_edit' };
  }
  return null;
}

/**
 * The item check of a library write (F4 fix rounds 2 and 3): throws unless
 * the caller's scope may `need` item `id`, as the database's edit check
 * raises it (editCheckRefusalError), so the one mapper answers it: an item
 * the scope does not read the 404, one it reads but may not change the 403
 * item-workspace (a tool: its error). Asked before anything is written. For
 * a write whose need depends on its body (an app restore's mode) or whose
 * route names no item (an import over an app), and for the gateways that
 * must not trust their callers (an app build, restore and import; a
 * folder's indexing switch; the named system step). System work is not
 * checked.
 */
export async function assertItemRight(
  id: string,
  need: ItemNeed,
  opts: ItemCheckOpts = {},
): Promise<void> {
  const refused = await itemWriteRefusalOf([id], need, opts);
  // A read-only snapshot copy: the database's own refusal of it (0267), so
  // the one mapper answers it in the copy's words, with readOnly.
  if (refused?.copy) throw new SnapshotCopyReadOnlyError();
  if (refused) throw editCheckRefusalError(refused.detail ?? 'no_read');
}

/**
 * The item check of a row whose rule is manage of its item, an Admin scope
 * for an item with no home (app_table_exports' read and write rule, 0302;
 * the write check's `manage`, 0278): throws the edit check's refusal
 * unless the current scope may, no_read for an item it does not read,
 * no_edit with `message` for one it reads but may not manage (plan v3 S3
 * fix round 3: an export link is asked this before anything is written).
 * assertItemRight's manage refuses an item with no home in every scope,
 * so it is not this. System work is not checked.
 */
export async function assertManageOrAdmin(id: string, message: string): Promise<void> {
  if (!currentWorkspaceScope()) return;
  const key = id.trim().toLowerCase();
  if (!UUID_RE.test(key)) throw editCheckRefusalError('no_read');
  // mantle_may_manage_home (0279): the row rule's own test (0302), one place.
  const rows = (await db.execute(sql`
    select "public"."mantle_may_manage_home"(n.home_ws) as ok
      from nodes n where n.id = ${key}::uuid`)) as unknown as { ok: boolean | null }[];
  const row = rows[0];
  if (!row) throw editCheckRefusalError('no_read');
  if (row.ok !== true) throw Object.assign(editCheckRefusalError('no_edit'), { message });
}

type ScopeRights = { edit: boolean; manage: boolean; copy: boolean };

/** What the current scope may do to each of `ids` (canonical uuids): an id
 *  it does not read is absent. */
async function scopeRightsOf(
  ids: readonly string[],
  conn: Pick<typeof db, 'execute'> = db,
): Promise<Map<string, ScopeRights>> {
  const arr = `{${ids.join(',')}}`;
  const rows = (await conn.execute(sql`
    select n.id::text as id,
           coalesce("public"."mantle_may_edit"(n.home_ws, n.write_ws), false) as edit,
           coalesce("public"."mantle_may_manage"(n.home_ws), false) as manage,
           coalesce(n.data ? 'snapshot_of', false) as copy
      from nodes n where n.id = any(${arr}::uuid[])`)) as unknown as ({
    id: string;
  } & ScopeRights)[];
  return new Map(rows.map((r) => [r.id, r]));
}

/** One item's verdict for `need`: the scope may (ok), does not read it,
 *  reads it but may not, or it is a read-only copy (an edit). */
function verdictOf(
  r: ScopeRights | undefined,
  need: ItemNeed,
  changes: boolean = need === 'edit',
): 'ok' | 'no_read' | 'no_edit' | 'copy' {
  if (!r) return 'no_read';
  if (need === 'read') return 'ok';
  if (changes && r.copy) return 'copy';
  return (need === 'edit' ? r.edit : r.manage) ? 'ok' : 'no_edit';
}

/**
 * The item check of a write whose items the BODY names (F4 fix round 2: a
 * bulk delete), one verdict per id, as itemWriteRefusalOf asks it for one:
 * 'ok', 'no_read' (the scope does not read it, or no row has the id: one
 * answer, so the two cannot be told apart) or 'no_edit' (it reads it but
 * may not make the write; a read-only copy's edit too). An id that is not a
 * canonical uuid is 'no_read'. Outside a workspace scope (system work)
 * every id is 'ok': the surface rules decide, as for itemWriteRefusalOf.
 */
export async function itemWriteVerdicts(
  ids: readonly string[],
  need: ItemNeed,
  /** The connection to ask on: a write's own transaction, when it asks
   *  while holding it (a whole folder's order, tree write.ts). */
  conn: Pick<typeof db, 'execute'> = db,
): Promise<Map<string, 'ok' | 'no_read' | 'no_edit'>> {
  const out = new Map<string, 'ok' | 'no_read' | 'no_edit'>();
  if (!currentWorkspaceScope()) {
    for (const id of ids) out.set(id, 'ok');
    return out;
  }
  const key = (id: string) => id.trim().toLowerCase();
  const canonical = [...new Set(ids.map(key).filter((i) => UUID_RE.test(i)))];
  const byId = canonical.length
    ? await scopeRightsOf(canonical, conn)
    : new Map<string, ScopeRights>();
  for (const id of ids) {
    const v = UUID_RE.test(key(id)) ? verdictOf(byId.get(key(id)), need) : 'no_read';
    out.set(id, v === 'copy' ? 'no_edit' : v);
  }
  return out;
}

/**
 * Which of `paths` the current scope reads as a folder of `ownerId`'s brain
 * (the queue-time create check, A5 step 6a fix round 1, M1). Asked in the
 * scope, as the rest of this module: a folder it does not read is not
 * returned, whether it exists or not.
 */
export async function foldersReadOf(
  ownerId: string,
  paths: readonly string[],
): Promise<Set<string>> {
  const list = [...new Set(paths.filter((p) => p.length > 0))];
  if (list.length === 0) return new Set();
  const rows = (await db.execute(sql`
    select n.path::text as path from nodes n
     where n.owner_id = ${ownerId} and n.type = 'branch'
       and n.path::text in (${sql.join(
         list.map((p) => sql`${p}`),
         sql`, `,
       )})`)) as unknown as { path: string }[];
  return new Set(rows.map((r) => r.path));
}
