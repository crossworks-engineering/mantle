/**
 * The folder rule (migration 0282), asked from TypeScript: a
 * folder move or delete that would leave behind rows the caller cannot read
 * is refused (42501, detail hidden_rows: a 409 on HTTP, the same words in
 * the tools). ONE helper for every pre-check (node folders ask it inside
 * their own transaction; Files folders before the disk moves).
 *
 * Through withSystemTx, the login write gateway, in every mode: a login's
 * scoped write runs it on the write role, where the rule applies; anything
 * else (the system pool: a box whose actor check is off, an Admin user's
 * HTTP request, a turn scope that writes nothing) runs it where it never
 * refuses. Never on the workspace role, which may not run the function.
 */
import { sql } from 'drizzle-orm';
import { withSystemTx } from './client';

export async function refuseHiddenRows(ownerId: string, path: string): Promise<void> {
  await withSystemTx((tx) =>
    tx.execute(sql`select mantle_subtree_refuse_hidden(${ownerId}, ${path}::ltree)`),
  );
}
