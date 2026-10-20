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
 * token): an API key, a linked brain, a public link and an assistant's turn
 * read the folders they read, as before. The definer answers only in a
 * scope with a login; with no scope (the system pool) it answers nothing,
 * and the caller then reads the folders it reads.
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from './client';
import { currentCaller } from './gate';

/** A folder named as structure: its id, path and name, nothing else. */
export type TrailFolder = { id: string; path: string; title: string };

/** Which folders to name (each answered only when it is at or above a row
 *  the scope reads): the direct children of the folder at `under`, the
 *  folders at the exact `paths`, the folder with id `folder`. */
export type TrailAsk = {
  under?: string | null;
  paths?: readonly string[];
  folder?: string | null;
};

/** Whether the current call is a login's own session, the one caller the
 *  trail is for. */
export function trailForCaller(): boolean {
  const c = currentCaller();
  return (c?.via === 'cookie' || c?.via === 'bearer') && c.actor?.kind === 'login';
}

/** The definer's rows as a FROM item aliased `alias` (columns id, path as
 *  ltree, title), for a read that folds them into its own statement; null
 *  when the current caller gets no trail. */
export function folderTrailSql(ownerId: string, ask: TrailAsk, alias = 't'): SQL | null {
  if (!trailForCaller()) return null;
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error(`bad alias: ${alias}`);
  const paths = ask.paths ?? [];
  const list = paths.length
    ? sql`array[${sql.join(
        paths.map((p) => sql`${p}`),
        sql`, `,
      )}]::text[]`
    : sql`'{}'::text[]`;
  return sql`(select r.id, r.path::ltree as path, r.title
                from "public"."mantle_folder_trail"(${ownerId}::uuid, ${ask.under ?? null}::text,
                                                    ${list}, ${ask.folder ?? null}::uuid) r) ${sql.raw(alias)}`;
}

/** The folders named by `ask` that the current login sees as structure
 *  (none for any other caller). */
export async function folderTrail(ownerId: string, ask: TrailAsk): Promise<TrailFolder[]> {
  const from = folderTrailSql(ownerId, ask);
  if (!from) return [];
  const rows = (await db.execute(
    sql`select t.id::text as id, t.path::text as path, t.title from ${from}`,
  )) as unknown as TrailFolder[];
  return rows;
}
