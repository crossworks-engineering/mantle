/**
 * Whether the Team workspace (bridge_key 'team') reads an item, for the
 * members' home app. Grants are the one truth of who reads an item; nothing
 * here touches a level column. (The Accept that gave Team a read grant was
 * removed with review in workspaces W5c.)
 */
import { sql } from 'drizzle-orm';
import { db } from '@mantle/db';

/** Whether the brain's Team workspace reads the item (it is in read_ws).
 *  False on a brain with no Team workspace. */
export async function teamReadsItem(ownerId: string, nodeId: string): Promise<boolean> {
  const [row] = (await db.execute(sql`
    select exists (
      select 1 from nodes n
        join workspaces w on w.owner_id = n.owner_id and w.bridge_key = 'team'
       where n.id = ${nodeId} and n.owner_id = ${ownerId} and w.id = any(n.read_ws)
    ) as ok`)) as unknown as Array<{ ok: boolean }>;
  return row?.ok === true;
}
