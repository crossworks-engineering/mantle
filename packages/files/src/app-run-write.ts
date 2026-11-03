/**
 * A team app's file write, asked where the write runs (@mantle/tools
 * member-app-tools.ts rule 7). Inside such a write (inAppRunWrite: the app
 * broker's write, as the running login in that login's own scope), the
 * write goes wherever the running user may write by hand (owner decision
 * 2026-11-03): the item checks of the operation itself (edit of a file it
 * writes over or renames, manage of a file it moves) and, here, edit of
 * the folder a file is placed in (a new file, a move): a Moderator of the
 * folder's home, or its Write switch on for one of their workspaces.
 * Anywhere else: nothing to check (a Files write by hand asks the database
 * alone).
 */
import { appRunMoveChangesReaders, assertItemRight, inAppRunWrite } from '@mantle/db';
import { ConflictError, editCheckRefusalError } from '@mantle/std';

export async function assertAppRunFileWrite(target: {
  /** The folder the write puts the file in, or keeps it in; null: none
   *  found (refused). Left out: the write names no folder (a rename). */
  folderId?: string | null;
  /** The file is placed in the folder (a new file, a move): edit of it. */
  place?: boolean;
}): Promise<void> {
  if (!inAppRunWrite()) return;
  if (target.folderId === undefined) return;
  if (!target.folderId) throw editCheckRefusalError('no_edit');
  if (target.place) await assertItemRight(target.folderId, 'edit');
}

/** The refusal of a team app's move that would change who reads a file. */
export const APP_MOVE_CHANGES_READERS =
  'A team app never changes who can see a file: this move would make a workspace start or stop reading it. Move it by hand in Files instead, or pick a folder the same workspaces read.';

/**
 * Inside a team app's write (inAppRunWrite): a check for moveFileById's
 * transaction (its MoveGuard, run with the file and both folders held)
 * that refuses a move changing who reads the file, against every grant
 * (appRunMoveChangesReaders). The visibility guard asked first in the
 * runner's scope; this holds where the move runs. Anywhere else: none.
 */
export function appRunMoveGuard(
  destPath: string,
): ((tx: unknown, fileId: string) => Promise<void>) | undefined {
  if (!inAppRunWrite()) return undefined;
  return async (_tx, fileId) => {
    if (await appRunMoveChangesReaders(fileId, destPath)) {
      throw new ConflictError(APP_MOVE_CHANGES_READERS);
    }
  };
}
