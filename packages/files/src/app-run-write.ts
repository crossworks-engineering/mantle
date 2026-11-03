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
import { assertItemRight, inAppRunWrite } from '@mantle/db';
import { editCheckRefusalError } from '@mantle/std';

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
