/**
 * The visibility confirm for a NEW page. A page
 * made in a folder takes the folder's grants and home from its first
 * moment, so the workspaces other than Admin that would read it are named
 * first ("This will also be visible to: ..."). Notes cannot be created in a
 * folder (they file through the guarded move) and a new file goes through
 * `guardNewFileIn`; this is the same guard for a page, so an agent's
 * `page_create` into a folder another workspace reads is refused with the
 * list until the user agrees. What the page embeds is not granted with it
 * (0261: nothing is granted for you), so it is not listed.
 */
import { db } from '@mantle/db';
import { NO_CHANGE, TreeVisibilityError, changeCount, newItemDiff } from './visibility';
import type { VisibilityDiff } from './visibility';
import type { ConfirmOpts } from './files-guard';

type Via = Pick<typeof db, 'execute'>;

/**
 * What a new page at `destPath` would change: the page itself, against the
 * same page at the root. Dry: nothing is written. `_doc` is no longer read
 * (embeds do not follow); the parameter stays for the callers.
 */
export async function newPageDiff(
  via: Via,
  ownerId: string,
  destPath: string,
  title: string,
  _doc: unknown,
): Promise<VisibilityDiff> {
  return newItemDiff(via, ownerId, 'pages', destPath, title);
}

/** A NEW page in the folder at `destPath`: refused with the list unless
 *  confirmed; with `seen`, refused again when the change differs now.
 *  `ownRow: false` leaves the page's own row out (a page made NEXT TO one
 *  that already shows there, by split or extract): nothing is left to ask. */
export async function guardNewPageIn(
  via: Via,
  ownerId: string,
  destPath: string,
  title: string,
  doc: unknown,
  opts: ConfirmOpts & { ownRow?: boolean },
): Promise<VisibilityDiff> {
  if (opts.ownRow === false) return NO_CHANGE;
  const diff = await newPageDiff(via, ownerId, destPath, title, doc);
  const count = changeCount(diff);
  if (count > 0 && !opts.confirm) throw new TreeVisibilityError(diff);
  if (opts.confirm && opts.seen !== undefined && count > 0 && count !== opts.seen) {
    throw new TreeVisibilityError(diff);
  }
  return diff;
}
