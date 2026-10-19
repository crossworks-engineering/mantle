/**
 * Test support for the trash of deleted apps (app-trash.ts): a purge by
 * hand. Product code purges through the trash's definer
 * (mantle_app_trash_act, 0310) or the nightly sweep
 * (purgeExpiredDeletedApps); this one only seeds and checks the purge rule
 * in DB tests (it was product code no product path called). Nothing in
 * the server imports it.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db, nodeSnapshots } from '@mantle/db';
import { AppTrashRefusedError } from '../app-trash';

/** Delete a deleted app for good, now. False when it is not in the trash.
 *  An app a login other than the brain's owner deleted is the owner's to
 *  purge (`byOwner`; CEO decision 1): refused for anyone else. The rule
 *  the definer keeps. */
export async function purgeDeletedApp(
  ownerId: string,
  appId: string,
  opts: { byOwner?: boolean } = {},
): Promise<boolean> {
  const [row] = (await db.execute(sql`
    select coalesce((s.code->'meta'->>'keepForOwner')::boolean, false) as held
      from node_snapshots s
     where s.owner_id = ${ownerId} and s.node_id = ${appId}
       and s.node_kind = 'app' and s.trigger = 'pre_delete'
       and not exists (select 1 from nodes n where n.id = s.node_id)
     order by s.seq desc
     limit 1`)) as unknown as { held: boolean }[];
  if (!row) return false;
  if (row.held && !opts.byOwner) {
    throw new AppTrashRefusedError(
      `app ${appId} was deleted by someone other than the brain owner: only the owner deletes it for good`,
    );
  }
  await db
    .delete(nodeSnapshots)
    .where(and(eq(nodeSnapshots.ownerId, ownerId), eq(nodeSnapshots.nodeId, appId)));
  return true;
}
