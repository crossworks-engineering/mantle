/**
 * Whether an item is homed in a workspace that holds an app (task
 * 2178377a, 2026-10-22): the target rule of a team app's Table row write
 * (@mantle/tools member-app-tools.ts rule 6). The holders are the ones an
 * app run reads through (AppRunFor, appRunHolders in gateway/viewer-scope.ts):
 * the live workspaces beyond Admin its grants name.
 */
import { sql } from 'drizzle-orm';
import { UUID_RE } from '@mantle/std';
import { getAdminDb } from './gateway/pools';
import { appRunHolders } from './gateway/viewer-scope';

/**
 * Whether the item `itemId` of `ownerId` is homed in a workspace that holds
 * the app `appId`. The app's database is shared by every holder, so a team
 * app changes only items homed where they work. A yes or no, never the
 * item: a missing item, one of another owner and an id that is not a uuid
 * all answer false. Admin pool.
 */
export async function appHolderHomes(
  ownerId: string,
  appId: string,
  itemId: string,
): Promise<boolean> {
  if (!UUID_RE.test(ownerId) || !UUID_RE.test(appId) || !UUID_RE.test(itemId)) return false;
  const held = await appRunHolders({ id: appId });
  if (held.length === 0) return false;
  const rows = (await getAdminDb().execute(
    sql`select 1 from nodes n
         where n.id = ${itemId}::uuid and n.owner_id = ${ownerId}::uuid
           and n.home_ws = any(${`{${held.join(',')}}`}::uuid[])
         limit 1`,
  )) as unknown as unknown[];
  return rows.length > 0;
}
