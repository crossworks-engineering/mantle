/**
 * The operator's recovery of the System workspace (pnpm -C server/web
 * system:add --email <x>). System is a subset of the Admin users: only a
 * System user adds someone there, so a brain whose System users are all
 * gone (left, disabled, deleted with the box's last word) has no way back
 * in the app. The operator on the box, who already holds the database,
 * adds one login: to Admin first when it is not an Admin user (an add to
 * Admin is the role change to admin, a Moderator there), then to System.
 *
 * Both adds are mantle_ws_add_user, the definer the workspace screen calls,
 * as workspace system work (systemWork 'system-add': the one actor the SQL
 * allowlist mantle_ws_system_work takes from this command, on that one
 * definer). The definer writes each workspace_events row (user.add) with no
 * actor. One transaction: a refusal of the second add undoes the first.
 * It never removes a row and never changes a password or a session.
 * Numbers only in its output: no names, no ids.
 */
import { sql } from 'drizzle-orm';
import { db, systemWork } from '@mantle/db';

export type SystemAddResult =
  | { ok: false; reason: 'no_login' | 'disabled' | 'no_system' }
  | { ok: true; addedToAdmin: boolean; addedToSystem: boolean };

type Tx = { execute: (typeof db)['execute'] };

async function one<T>(tx: Tx, query: ReturnType<typeof sql>): Promise<T | undefined> {
  return ((await tx.execute(query)) as unknown as T[])[0];
}

/** Put the login with `email` in Admin (when it is not there) and in
 *  System. An archived or disabled login is refused: the definer would not
 *  count it as an Admin user. */
export async function systemAdd(email: string): Promise<SystemAddResult> {
  const address = email.trim().toLowerCase();
  if (!address) return { ok: false, reason: 'no_login' };
  return systemWork(
    () =>
      db.transaction(async (tx): Promise<SystemAddResult> => {
        const login = await one<{ id: string; off: boolean }>(
          tx,
          sql`select l.id::text as id,
                     (l.disabled_at is not null or l.archived_at is not null) as off
                from auth.users l where lower(l.email) = ${address}`,
        );
        if (!login) return { ok: false, reason: 'no_login' };
        if (login.off) return { ok: false, reason: 'disabled' };
        const ws = await one<{ admin: string | null; system: string | null }>(
          tx,
          sql`select mantle_ws_admin_id(mantle_brain_id())::text as admin,
                     mantle_ws_system_id(mantle_brain_id())::text as system`,
        );
        if (!ws?.admin || !ws.system) return { ok: false, reason: 'no_system' };
        const seats = (await tx.execute(
          sql`select u.workspace_id::text as ws from workspace_users u
               where u.login_id = ${login.id}::uuid
                 and u.workspace_id in (${ws.admin}::uuid, ${ws.system}::uuid)`,
        )) as unknown as { ws: string }[];
        const has = new Set(seats.map((s) => s.ws));
        const todo = [ws.admin, ws.system].filter((w) => !has.has(w));
        for (const w of todo) {
          await tx.execute(
            sql`select "public"."mantle_ws_add_user"(mantle_brain_id(), ${w}::uuid,
                         ${login.id}::uuid, true)`,
          );
        }
        return {
          ok: true,
          addedToAdmin: !has.has(ws.admin),
          addedToSystem: !has.has(ws.system),
        };
      }),
    'system-add',
  );
}
