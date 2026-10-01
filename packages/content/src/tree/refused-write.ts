/**
 * The writes a tree READ makes for itself (docs/folder-tree.md, "Reading"):
 * a kind's root row, and the once-only moves of what older brains kept
 * elsewhere. A database that refuses writes (a read-only replica, a role with
 * SELECT only such as the public demo's reader) must still serve the read, so
 * these writes are skipped there and the tree is read from the rows that exist.
 *
 * Selecting first is not enough by itself: Postgres checks the table's
 * privilege when the statement starts, before it looks at a single row, so an
 * `INSERT ... ON CONFLICT DO NOTHING` of a row that exists, or an `UPDATE`
 * that would match nothing, is refused all the same. The statement has to not
 * run, or its refusal has to be caught.
 */
import { isWriteRefused } from '@mantle/db';

/**
 * After a refusal, how long reads go without trying a write again. A database
 * that refused one write refuses the next (a reader role stays a reader), and
 * each try is a failed statement in its log, on every read. One that takes
 * writes again (a replica promoted in place) is asked again after this.
 */
export const WRITE_RETRY_AFTER_MS = 5 * 60_000;

let refusedAt: number | null = null;
let warned = false;

/**
 * Run a write a read makes for itself. Answers null when the database refused
 * it (or refused one lately: the write is then not tried), and says so once
 * per process. Narrow on purpose (isWriteRefused): any other failure is a
 * real one and still throws.
 */
export async function unlessWriteRefused<T>(write: () => Promise<T>): Promise<T | null> {
  if (refusedAt !== null && Date.now() - refusedAt < WRITE_RETRY_AFTER_MS) return null;
  try {
    const result = await write();
    refusedAt = null;
    return result;
  } catch (err) {
    if (!isWriteRefused(err)) throw err;
    refusedAt = Date.now();
    if (!warned) {
      warned = true;
      console.warn(
        '[tree] the database refuses writes (a read-only database or a role ' +
          'without INSERT or UPDATE): tree reads skip the root rows and once-only ' +
          'moves they would make, and serve what is there. Logged once per process.',
      );
    }
    return null;
  }
}

/** Forget the last refusal, so the next write is tried (tests). */
export function forgetWriteRefusal(): void {
  refusedAt = null;
}
