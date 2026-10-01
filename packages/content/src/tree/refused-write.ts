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
import { bestEffortWrite } from '@mantle/db';

/**
 * Run a write a tree read makes for itself. Answers null when the database
 * refused it (or refused one lately: the write is then not tried for
 * WRITE_RETRY_AFTER_MS). Any other failure still throws.
 */
export function unlessWriteRefused<T>(write: () => Promise<T>): Promise<T | null> {
  return bestEffortWrite('tree reads skip the root rows and once-only moves they make', write);
}
