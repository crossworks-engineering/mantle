/**
 * The folders above what a login reads, as structure only (migration 0311,
 * mantle_folder_trail). The owner's rule: a login that can read an item also
 * sees its folder and every folder above it, by id, path and name, so a tree
 * can lead to the item and a crumb can name the way. Nothing else of such a
 * folder is read (no look, no description, no dates), no other item in it is
 * shown, and no write path asks this: a folder the caller does not read is
 * still not found by every write (they read the row rules), so it cannot be
 * moved, renamed, shared or written into without the right on it.
 *
 * Only a login's own session asks (a browser cookie, the phone's bearer
 * token), and only in a workspace scope with that login: an API key, a
 * linked brain, a public link and an assistant's turn read the folders they
 * read, as before. The brain's owner (it reads every folder) asks nothing,
 * so its reads are the statements they were.
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from './client';
import { currentCaller } from './gate';
import { currentWorkspaceScope } from './viewer';

/** A folder named as structure: its id, path and name, nothing else. */
export type TrailFolder = { id: string; path: string; title: string };

/** Which folders to name (each answered only when it is at or above a row
 *  the scope reads): the folders one and two levels below the folder at
 *  `under` (a page's folders and what each unfolds to), the folders at the
 *  exact `paths`, the folder with id `folder`. */
export type TrailAsk = {
  under?: string | null;
  paths?: readonly string[];
  folder?: string | null;
};

/** Whether the current call is a login's own session in a workspace scope
 *  of that login, the one caller the trail is for. The brain's owner reads
 *  every folder and gets none (its statements are the ones they were). */
export function trailForCaller(): boolean {
  const c = currentCaller();
  const actor = c?.actor;
  if (!(c?.via === 'cookie' || c?.via === 'bearer') || actor?.kind !== 'login') return false;
  if (actor.mode === 'owner') return false;
  return Boolean(currentWorkspaceScope()?.loginId);
}

/** `values` as one text[] parameter (one bind, however many). */
export function textArraySql(values: readonly string[]): SQL {
  const quoted = values.map((v) => `"${v.replace(/[\\"]/g, '\\$&')}"`);
  return sql`${`{${quoted.join(',')}}`}::text[]`;
}

/** The definer's rows as a parenthesised FROM item (columns id, path as
 *  ltree, title) for a read that folds them into its own statement and
 *  names its alias after it; null when the current caller gets no trail. */
export function folderTrailSql(ownerId: string, ask: TrailAsk): SQL | null {
  if (!trailForCaller()) return null;
  return sql`(select r.id, r.path::ltree as path, r.title
                from "public"."mantle_folder_trail"(${ownerId}::uuid, ${ask.under ?? null}::text,
                                                    ${textArraySql(ask.paths ?? [])},
                                                    ${ask.folder ?? null}::uuid) r)`;
}

/** The folders named by `ask` that the current login sees as structure
 *  (none for any other caller). */
export async function folderTrail(ownerId: string, ask: TrailAsk): Promise<TrailFolder[]> {
  const from = folderTrailSql(ownerId, ask);
  if (!from) return [];
  const rows = (await db.execute(
    sql`select t.id::text as id, t.path::text as path, t.title from ${from} t`,
  )) as unknown as TrailFolder[];
  return rows;
}
