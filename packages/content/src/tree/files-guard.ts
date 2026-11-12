/**
 * The visibility confirm for Files MOVES made OUTSIDE the tree routes: the
 * Files screen's own move routes and the agent tools file_move and
 * folder_move. They call the Files operations directly, so the tree's own
 * check (write.ts) never ran for them.
 *
 * Each guard computes the change DRY (./visibility), before the write, and
 * throws TreeVisibilityError when a workspace would start or stop reading
 * something and the caller did not confirm.
 *
 * A NEW file (uploaded, created or copied) has no guard: it takes the
 * folder's sharing, like every other item in it (owner's word, 2026-11-12).
 */
import { sql } from 'drizzle-orm';
import { db } from '@mantle/db';
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
  if (opts.confirm && opts.seen !== undefined && diff.total > 0 && diff.total !== opts.seen) {
    throw new TreeVisibilityError(diff);
  }
  return diff;
}

/** A file moving into the folder at `destPath`. */
export async function guardFileTo(
  ownerId: string,
  fileId: string,
  destPath: string,
  opts: ConfirmOpts,
): Promise<VisibilityDiff> {
  return check(await moveItemsDiff(ownerId, 'files', [fileId], destPath), opts);
}

/** A Files folder moving under `destParentPath`. An id that is not the
 *  owner's folder passes: the operation itself refuses it. */
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
