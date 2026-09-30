/**
 * Members' drafts ride along with the brain's folders (folder plan phase 5).
 *
 * A member's draft and a member's own folder are rows owned by the member's
 * personal space that carry a BRAIN folder path (`notes.clients.acme`). When
 * an admin renames, moves or deletes that brain folder, the space rows under
 * it must follow in the same transaction, or they would sit at a path no
 * brain folder has. One helper for every kind: the node-row folders
 * (content tree/node-ops) and the Files folders (files ops) both call it.
 * Member file bytes are keyed by id (MANTLE_SPACES_ROOT), never by path, so
 * nothing on disk moves.
 *
 * How a space row maps: `oldPath` becomes `newPath` and the rest of its path
 * follows. Then, per space:
 *   - a member folder whose new path is a folder that space already has
 *     (outside the moved subtree) merges into it: the duplicate row goes, its
 *     contents land in the existing folder by path;
 *   - with `lift` (the brain folder is being deleted, its contents move up),
 *     the member's own folder AT `oldPath` goes too, its contents lifted;
 *   - anything that would sit deeper than TREE_MAX_DEPTH folders is clamped:
 *     folders past the limit merge into the deepest allowed one, items land
 *     there. The admin's move was checked against the brain's own subtree;
 *     a member's private folders never block it.
 * Items keep their `updated_at`: filing is not editing.
 *
 * Files: a member's files and file folders never sit under `files` (every
 * brain file helper, the disk watcher and the extractor resolve that root);
 * they mirror it under `space_files` (brain `files.docs` is the member's
 * `space_files.docs`, see spaceFilesPath). A Files folder carries both.
 *
 * A no-op when `ownerId` is not a brain (a member reorganising its own
 * folders moves only its own rows).
 */
import { sql } from 'drizzle-orm';
import type { Db } from './client';

/** Root plus three folder levels (TREE_MAX_DEPTH in @mantle/client-types). */
const MAX_TREE_NLEVEL = 4;

/** The label a carry parks rows under between its two passes (never a kind
 *  root, so no folder check applies; one carry per brain at a time, under
 *  the brain's share write lock). */
const CARRY_TMP = 'mantle_carry_tmp';

const FILES_ROOT = 'files';
export const SPACE_FILES_ROOT = 'space_files';

/** Where a member's copy of a brain Files path lives: `files.a.b` is
 *  `space_files.a.b`, the root `files` is `space_files`. Other paths are
 *  their own. */
export function spaceFilesPath(path: string): string {
  return path === FILES_ROOT || path.startsWith(`${FILES_ROOT}.`)
    ? SPACE_FILES_ROOT + path.slice(FILES_ROOT.length)
    : path;
}

export async function carrySpaceRows(
  tx: Pick<Db, 'execute'>,
  ownerId: string,
  oldPath: string,
  newPath: string,
  opts: { lift?: boolean } = {},
): Promise<number> {
  const [brain] = (await tx.execute(sql`
    select 1 as ok from spaces where id = ${ownerId} and kind = 'brain'`)) as unknown as {
    ok: number;
  }[];
  if (!brain || oldPath === newPath) return 0;
  let moved = await carry(tx, oldPath, newPath, !!opts.lift);
  const mirrorOld = spaceFilesPath(oldPath);
  if (mirrorOld !== oldPath) {
    moved += await carry(tx, mirrorOld, spaceFilesPath(newPath), !!opts.lift);
  }
  return moved;
}

async function carry(
  tx: Pick<Db, 'execute'>,
  oldPath: string,
  newPath: string,
  lift: boolean,
): Promise<number> {
  const mapped = sql`case when n.path = ${oldPath}::ltree then text2ltree(${newPath})
                          else (text2ltree(${newPath}) || subpath(n.path, nlevel(${oldPath}::ltree)))::ltree end`;
  const inSpaces = sql`n.owner_id in (select s.id from spaces s where s.kind = 'personal')
                       and n.path <@ ${oldPath}::ltree`;
  // Folders that merge or clamp away first, so the rewrite below never meets
  // the (owner, path) unique index.
  await tx.execute(sql`
    delete from nodes n
     where ${inSpaces} and n.type = 'branch'
       and (nlevel(${mapped}) > ${MAX_TREE_NLEVEL}
            or (${lift} and n.path = ${oldPath}::ltree)
            or exists (select 1 from nodes b
                        where b.owner_id = n.owner_id and b.type = 'branch'
                          and b.path = ${mapped}
                          and not (b.path <@ ${oldPath}::ltree)))`);
  // Two passes through a temporary prefix: in one UPDATE a row's new path
  // can be another moving row's old one (a lift maps `a.o.o.y` onto `a.o.y`,
  // which itself moves on to `a.y`), and the unique index is checked row by
  // row, so a single pass failed or not by physical order (folder audit C3).
  // The prefix sits outside every kind root, so no folder check applies.
  await tx.execute(sql`
    update nodes n set path = text2ltree(${CARRY_TMP}) || n.path where ${inSpaces}`);
  const from = sql`subpath(n.path, 1)`;
  const mappedTmp = sql`case when ${from} = ${oldPath}::ltree then text2ltree(${newPath})
                             else (text2ltree(${newPath}) || subpath(${from}, nlevel(${oldPath}::ltree)))::ltree end`;
  const moved = (await tx.execute(sql`
    update nodes n
       set path = subpath(${mappedTmp}, 0, least(nlevel(${mappedTmp}), ${MAX_TREE_NLEVEL}))
     where n.owner_id in (select s.id from spaces s where s.kind = 'personal')
       and n.path <@ (text2ltree(${CARRY_TMP}) || ${oldPath}::ltree)
    returning n.id`)) as unknown as unknown[];
  return moved.length;
}
