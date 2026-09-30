/**
 * The visibility confirm for Files writes made OUTSIDE the tree routes
 * (folder plan section 4, "Confirm before visibility changes"): the Files
 * screen's own move and copy routes and the agent tools file_move,
 * file_copy, folder_move, folder_copy, file_create and file_upload. They
 * call the Files operations directly, so the tree's own check (write.ts)
 * never ran for them, and a file moved, copied or written into a shared
 * folder became readable by the team or clients with nobody asked.
 *
 * Each guard computes the change DRY (./visibility), before the write, and
 * throws TreeVisibilityError when something would be read at another level
 * and the caller did not confirm. A copy is judged like a move: the content
 * is what becomes readable where it lands.
 */
import { sql } from 'drizzle-orm';
import { db } from '@mantle/db';
import { TREE_KIND_SPECS, type TreeShareLevel } from '@mantle/client-types/tree';
import { effectiveLevel } from '@mantle/content-core/tree';
import type { AccessLevel } from '@mantle/client-types';
import {
  moveFolderDiff,
  moveItemsDiff,
  NO_CHANGE,
  TreeVisibilityError,
  type VisibilityDiff,
} from './visibility';

/** As the tree writes take it (TreeWriteOpts): `seen` is the total the
 *  caller was shown; a different change now is refused again. */
export type ConfirmOpts = { confirm?: boolean; seen?: number };

function check(diff: VisibilityDiff, opts: ConfirmOpts): VisibilityDiff {
  if (diff.total > 0 && !opts.confirm) throw new TreeVisibilityError(diff);
  if (opts.confirm && opts.seen !== undefined && diff.total !== opts.seen) {
    throw new TreeVisibilityError(diff);
  }
  return diff;
}

/** A file moving (or copied) into the folder at `destPath`. */
export async function guardFileTo(
  ownerId: string,
  fileId: string,
  destPath: string,
  opts: ConfirmOpts,
): Promise<VisibilityDiff> {
  return check(await moveItemsDiff(ownerId, 'files', [fileId], destPath), opts);
}

/** A Files folder moving (or copied) under `destParentPath`. An id that is
 *  not the owner's folder passes: the operation itself refuses it. */
export async function guardFolderTo(
  ownerId: string,
  folderId: string,
  destParentPath: string,
  opts: ConfirmOpts,
): Promise<VisibilityDiff> {
  const [folder] = (await db.execute(sql`
    select id, path::text as path from nodes
     where id = ${folderId} and owner_id = ${ownerId} and type = 'branch'`)) as unknown as Array<{
    id: string;
    path: string;
  }>;
  if (!folder) return NO_CHANGE;
  return check(await moveFolderDiff(ownerId, folder, destParentPath), opts);
}

/** A NEW file (created or uploaded, at the admin level) in the folder at
 *  `destPath`: read at the folder's share if it has one. */
export async function guardNewFileIn(
  ownerId: string,
  destPath: string,
  title: string,
  opts: ConfirmOpts,
): Promise<VisibilityDiff> {
  const [row] = (await db.execute(sql`
    select mantle_inherited_level(${ownerId}::uuid, ${destPath}::ltree,
                                  ${TREE_KIND_SPECS.files.nodeType}::node_type) as share`)) as unknown as Array<{
    share: TreeShareLevel | null;
  }>;
  const from: AccessLevel = 'admin';
  const to = effectiveLevel(from, row?.share ?? null);
  if (to === from) return NO_CHANGE;
  return check({ changes: [{ id: '', title, from, to }], total: 1 }, opts);
}
