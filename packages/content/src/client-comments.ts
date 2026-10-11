/**
 * The clean-up of a deleted client login's old comments (comments are gone
 * from the brain since 2026-10-09; the rows a client wrote earlier still go
 * with their login). Admin pool only: the login delete route calls it after
 * getOwnerOr401. No LLM work.
 */
import { sql } from 'drizzle-orm';
import { db } from '@mantle/db';

/**
 * Delete every comment a client login wrote on this brain before comments
 * were removed (2026-10-09): its old client-thread and review rows (author
 * kind client, that login). Nothing writes comments any more; the old rows
 * still go with their login. Returns how many went. `via`: the login delete
 * runs it in its own transaction, before the login row goes (audit I5): once
 * the login is gone its comments keep no login id, so nothing could find
 * them any more.
 */
export async function deleteClientComments(
  brainId: string,
  loginId: string,
  via: Pick<typeof db, 'execute'> = db,
): Promise<number> {
  const gone = (await via.execute(sql`
    delete from node_comments
     where owner_id = ${brainId} and author_kind = 'client' and login_id = ${loginId}
    returning id`)) as unknown as { id: string }[];
  return gone.length;
}
