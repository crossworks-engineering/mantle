/**
 * What the current workspace scope may do to items (workspaces W7a fix
 * round 1, M2): the one edit check of a write to an item made from a tool,
 * in a turn or on MCP, as the item routes ask it since W6a (the session's
 * item write gate): mantle_may_edit for a content change or a link,
 * mantle_may_manage for a delete or a move (an app's link: assertMayLink), a read for a write that only needs to see
 * the item. A read-only snapshot copy (data.snapshot_of) is never edited.
 *
 * A typed write in a scope runs on the system pool with no scope on its
 * statement (client.ts), so the database cannot ask this itself: the tool
 * asks it here first, in the caller's scope, before it writes.
 *
 * Asked in the scope only: an item the scope does not read answers "not in
 * your workspaces", whether it exists or not, so no item's existence leaves
 * the scope. Outside a workspace scope (system work) nothing is checked:
 * the surface rules decide, as before.
 */
import { sql } from 'drizzle-orm';
import { db } from './client';
import { currentWorkspaceScope } from './viewer';
import { UUID_RE } from '@mantle/std';

/** What a write needs of an item. */
export type ItemNeed = 'read' | 'edit' | 'manage';

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
export const READ_ONLY_COPY_ERROR =
  'This is a read-only copy of an accepted item: nobody changes it. Its author may delete it.';

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
}>;

/** itemWriteRefusal, with the edit check's detail (A5 step 4 fix round 2:
 *  a /api/v1 route answers the refusal as the database's, by its detail). */
export async function itemWriteRefusalOf(
  ids: readonly string[],
  need: ItemNeed,
): Promise<ItemWriteRefusal | null> {
  if (!currentWorkspaceScope()) return null;
  const trimmed = ids.map((i) => i.trim().toLowerCase());
  const loose = trimmed.find((i) => !UUID_RE.test(i) && LOOSE_UUID_RE.test(i));
  if (loose !== undefined) return { message: itemIdNotCanonicalError(loose), detail: null };
  const list = [...new Set(trimmed.filter((i) => UUID_RE.test(i)))];
  if (list.length === 0) return null;
  const arr = `{${list.join(',')}}`;
  const rows = (await db.execute(sql`
    select n.id::text as id,
           coalesce("public"."mantle_may_edit"(n.home_ws, n.write_ws), false) as edit,
           coalesce("public"."mantle_may_manage"(n.home_ws), false) as manage,
           coalesce(n.data ? 'snapshot_of', false) as copy
      from nodes n where n.id = any(${arr}::uuid[])`)) as unknown as {
    id: string;
    edit: boolean;
    manage: boolean;
    copy: boolean;
  }[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of list) {
    const r = byId.get(id);
    if (!r) return { message: itemNotInScopeError(id), detail: 'no_read' };
    if (need === 'read') continue;
    if (need === 'edit' && r.copy) return { message: READ_ONLY_COPY_ERROR, detail: 'no_edit' };
    if (need === 'edit' ? !r.edit : !r.manage) {
      return { message: itemNoRightError(id, need), detail: 'no_edit' };
    }
  }
  return null;
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
