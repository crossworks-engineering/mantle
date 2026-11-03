/**
 * A team app's file write, asked where the write runs (@mantle/tools
 * member-app-tools.ts rule 7 asked it first, in the verdict). Inside such a
 * write (inAppRunWrite: the app broker's write scope, as the running login,
 * in the app's scope of its one holder), the folder and the file the write
 * touches are homed in that holder, and a folder the file is placed in (a
 * new file, a move) is one the running user may edit: a Moderator of its
 * home, or its Write switch on for their workspace; and a file it moves is
 * read by no workspace but the holder (and Admin). So a folder or a file
 * moved between the verdict and the dispatch takes no write outside the
 * rule. Anywhere else: nothing to check.
 */
import {
  assertAppRunWriteHolderAlone,
  assertAppRunWriteHome,
  assertItemRight,
  inAppRunWrite,
} from '@mantle/db';
import { editCheckRefusalError } from '@mantle/std';

export async function assertAppRunFileWrite(target: {
  /** The folder the write puts the file in, or keeps it in; null: none
   *  found (refused). Left out: the write names no folder (a rename). */
  folderId?: string | null;
  /** The file the write changes (an overwrite, a move, a rename). */
  fileId?: string;
  /** The file is placed in the folder (a new file, a move): edit of it. */
  place?: boolean;
}): Promise<void> {
  if (!inAppRunWrite()) return;
  if (target.folderId !== undefined) {
    if (!target.folderId) throw editCheckRefusalError('no_edit');
    await assertAppRunWriteHome(target.folderId);
    if (target.place) await assertItemRight(target.folderId, 'edit');
  }
  if (target.fileId !== undefined) {
    await assertAppRunWriteHome(target.fileId);
    // A move (a file placed in another folder): only of a file no workspace
    // but the holder (and Admin) reads, as the scope cannot see the grants
    // it would take from another workspace (the visibility guard's lose).
    if (target.place) await assertAppRunWriteHolderAlone(target.fileId);
  }
}
