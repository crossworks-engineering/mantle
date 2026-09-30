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
 * A no-op when `ownerId` is not a brain (a member reorganising its own
 * folders moves only its own rows).
 */
import { sql } from 'drizzle-orm';
import type { Db } from './client';

/** Root plus three folder levels (TREE_MAX_DEPTH in @mantle/client-types). */
const MAX_TREE_NLEVEL = 4;

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
  const lift = !!opts.lift;
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
  const moved = (await tx.execute(sql`
    update nodes n
       set path = subpath(${mapped}, 0, least(nlevel(${mapped}), ${MAX_TREE_NLEVEL}))
     where ${inSpaces}
    returning n.id`)) as unknown as unknown[];
  return moved.length;
}
