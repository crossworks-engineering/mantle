/**
 * Whether an item is homed in a workspace that holds an app: the target rule
 * of a team app's Table row write and file write (@mantle/tools
 * member-app-tools.ts rules 6 and 7). The holder is the one an app
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

/** The kinds a team app writes in its holder: a Table's rows, a file. */
export type AppHolderWriteKind = 'table' | 'file';

/**
 * Whether the item `itemId` of `ownerId`, of `kind` (a Table, by default,
 * or a file), is homed in the workspace that holds the app `appId` (exactly
 * one beyond Admin, as viewerScopeFor's app scope reads). The app's database
 * is shared by every holder, so a team app changes only items homed where
 * they work. A yes or no, never the item: a missing item, one of another
 * owner, one of another kind and an id that is not a uuid all answer false.
 * Admin pool.
 */
export async function appHolderHomes(
  ownerId: string,
  appId: string,
  itemId: string,
  kind: AppHolderWriteKind = 'table',
): Promise<boolean> {
  if (!UUID_RE.test(ownerId) || !UUID_RE.test(appId) || !UUID_RE.test(itemId)) return false;
  const held = await appRunHolders({ id: appId });
  if (held.length !== 1) return false;
  const rows = (await getAdminDb().execute(
    sql`select 1 from nodes n
         where n.id = ${itemId}::uuid and n.owner_id = ${ownerId}::uuid
           and n.type = ${kind}::node_type and n.home_ws = ${held[0]!}::uuid
         limit 1`,
  )) as unknown as unknown[];
  return rows.length > 0;
}

/**
 * Whether the Files folder at `path` (an ltree path below `files`) of
 * `ownerId` is homed in the workspace that holds the app `appId`: where a
 * team app's file write may put a file (member-app-tools.ts rule 7). The
 * files root itself is the brain's structure, homed in Admin: never. A
 * path that is no folder answers false. Admin pool.
 */
export async function appHolderHomesFolder(
  ownerId: string,
  appId: string,
  path: string,
): Promise<boolean> {
  if (!UUID_RE.test(ownerId) || !UUID_RE.test(appId)) return false;
  if (typeof path !== 'string' || !path.startsWith('files.') || path.length > 500) return false;
  const held = await appRunHolders({ id: appId });
  if (held.length !== 1) return false;
  const rows = (await getAdminDb().execute(
    sql`select 1 from nodes n
         where n.owner_id = ${ownerId}::uuid and n.type = 'branch'
           and pg_input_is_valid(${path}, 'ltree') and n.path::text = ${path}
           and n.home_ws = ${held[0]!}::uuid
         limit 1`,
  )) as unknown as unknown[];
  return rows.length > 0;
}

/**
 * Whether no workspace but the app's holder (and Admin) reads the item
 * `itemId` of `ownerId` now (nodes.read_ws). A team app's move takes the
 * grants the file had from the folder it leaves: a file another workspace
 * reads would stop being read there, and the app's scope (its holder) does
 * not see that workspace's grant to ask (member-app-tools.ts rule 7). A
 * missing item answers false. Admin pool, whatever the caller's scope.
 */
export async function appHolderAloneReads(
  ownerId: string,
  appId: string,
  itemId: string,
): Promise<boolean> {
  if (!UUID_RE.test(ownerId) || !UUID_RE.test(appId) || !UUID_RE.test(itemId)) return false;
  const held = await appRunHolders({ id: appId });
  if (held.length !== 1) return false;
  return holderAloneReads(ownerId, held[0]!, itemId);
}

/** The read of appHolderAloneReads for a known holder. Admin pool. */
async function holderAloneReads(ownerId: string, holder: string, itemId: string): Promise<boolean> {
  const rows = (await getAdminDb().execute(
    sql`select 1 from nodes n
         where n.id = ${itemId}::uuid and n.owner_id = ${ownerId}::uuid
           and not exists (
             select 1 from unnest(coalesce(n.read_ws, '{}'::uuid[])) as r(ws)
              where r.ws <> ${holder}::uuid
                and not exists (select 1 from workspaces w where w.id = r.ws and w.is_admin))
         limit 1`,
  )) as unknown as unknown[];
  return rows.length > 0;
}

/**
 * Inside a team app's allowed write (inAppRunWrite): refuse unless no
 * workspace but the app's one holder (and Admin) reads the item `id`, asked
 * again where a move runs (appHolderAloneReads asked it in the verdict).
 * The edit check's refusal (no_edit). Anywhere else: nothing to check.
 */
export async function assertAppRunWriteHolderAlone(id: string): Promise<void> {
  if (!inAppRunWrite()) return;
  const scope = currentWorkspaceScope();
  const key = id.trim().toLowerCase();
  const holder = scope?.ws.length === 1 ? scope.ws[0]! : null;
  if (!scope || !holder || !UUID_RE.test(key)) throw editCheckRefusalError('no_edit');
  const [owner] = (await getAdminDb().execute(
    sql`select n.owner_id::text as owner from nodes n where n.id = ${key}::uuid`,
  )) as unknown as { owner: string }[];
  if (!owner || !(await holderAloneReads(owner.owner, holder, key))) {
    throw editCheckRefusalError('no_edit');
  }
}

/** Inside a team app's allowed write (inAppRunWrite): the one workspace its
 *  scope holds (the app's holder), else null. Where its new file lands. */
export function appRunWriteHolder(): string | null {
  if (!inAppRunWrite()) return null;
  const scope = currentWorkspaceScope();
  return scope?.ws.length === 1 ? scope.ws[0]! : null;
}

/**
 * Inside a team app's allowed write (inAppRunWrite): refuse unless the item
 * `id` is homed in the app's scope (its one holder). The verdict asked it
 * (appHolderHomes, appHolderHomesFolder); this asks again where the write
 * runs, so a Table, a file or a folder moved between the verdict and the
 * dispatch takes no write outside the rule.
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
