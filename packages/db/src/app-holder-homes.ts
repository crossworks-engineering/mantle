/**
 * Whether an item is homed in a workspace that holds an app: the target rule of a team app's Table row write
 * (@mantle/tools member-app-tools.ts rule 6). The holder is the one an app
 * run reads through (AppRunFor, appRunHolders and viewerScopeFor in
 * gateway/viewer-scope.ts): the one live workspace beyond Admin its grants
 * name. An app two workspaces hold reads none, so it writes none either.
 */
import { sql } from 'drizzle-orm';
import { editCheckRefusalError, UUID_RE } from '@mantle/std';
import { db } from './gateway/handles';
import { getAdminDb } from './gateway/pools';
import { appRunHolders, inAppRunWrite } from './gateway/viewer-scope';
import { currentWorkspaceScope } from './viewer';

/**
 * Whether the Table `itemId` of `ownerId` is homed in the workspace that
 * holds the app `appId` (exactly one beyond Admin, as viewerScopeFor's app
 * scope reads). The app's database is shared by every holder, so a team
 * app changes only Tables homed where they work. A yes or no, never the
 * item: a missing item, one of another owner, one that is not a Table and
 * an id that is not a uuid all answer false. Admin pool.
 */
export async function appHolderHomes(
  ownerId: string,
  appId: string,
  itemId: string,
): Promise<boolean> {
  if (!UUID_RE.test(ownerId) || !UUID_RE.test(appId) || !UUID_RE.test(itemId)) return false;
  const held = await appRunHolders({ id: appId });
  if (held.length !== 1) return false;
  const rows = (await getAdminDb().execute(
    sql`select 1 from nodes n
         where n.id = ${itemId}::uuid and n.owner_id = ${ownerId}::uuid
           and n.type = 'table' and n.home_ws = ${held[0]!}::uuid
         limit 1`,
  )) as unknown as unknown[];
  return rows.length > 0;
}

/**
 * Inside a team app's allowed write (inAppRunWrite): refuse unless the item
 * `id` is homed in the app's scope (its one holder). The verdict asked it
 * (appHolderHomes); this asks again where the write runs, so a Table moved
 * between the verdict and the dispatch takes no write outside the rule.
 * The edit check's refusal (no_edit). Anywhere else: nothing to check.
 */
export async function assertAppRunWriteHome(id: string): Promise<void> {
  if (!inAppRunWrite()) return;
  const scope = currentWorkspaceScope();
  const key = id.trim().toLowerCase();
  if (!scope || !UUID_RE.test(key)) throw editCheckRefusalError('no_edit');
  const rows = (await db.execute(
    sql`select n.home_ws::text as home from nodes n where n.id = ${key}::uuid`,
  )) as unknown as { home: string | null }[];
  const home = rows[0]?.home ?? null;
  if (!home || !scope.ws.includes(home)) throw editCheckRefusalError('no_edit');
}
