/**
 * The operator's recovery of the System workspace (pnpm -C server/web
 * system:add --email <x>). System is a subset of the Admin users: only a
 * System user adds someone there, so a brain whose System users are all
 * gone (left, disabled, deleted with the box's last word) has no way back
 * in the app. The operator on the box, who already holds the database,
 * adds one login: to Admin first when it is not an Admin user (an add to
 * Admin is the role change to admin, a Moderator there), then to System.
 *
 * A brain with Admin and no System gets System made first
 * (mantle_ws_ensure_system, the migration's step: every Admin user seated,
 * on the migrator's connection as the workspaces switch runs).
 * An add to Admin settles the login's personal space as the Users screen's
 * role change does (settleSpaceOnPromotion).
 *
 * Both adds are mantle_ws_add_user, the definer the workspace screen calls,
 * as workspace system work (systemWork 'system-add': the one actor the SQL
 * allowlist mantle_ws_system_work takes from this command, on that one
 * definer). The definer writes each workspace_events row (user.add) with no
 * actor. One transaction: a refusal of the second add undoes the first.
 * It never removes a row and never changes a password or a session.
 * no_system means the brain has no Admin workspace at all.
 * Numbers only in its output: no names, no ids.
 */
import { sql } from 'drizzle-orm';
import { db, executeAsMigrator, systemWork, systemUserTargetRefused } from '@mantle/db';
import { settleSpaceOnPromotion } from '@mantle/content';
import type { SystemUserTargetRefused } from '@mantle/client-types';

/** The words of the refusal below (owner, 2026-11-19). */
export const SYSTEM_USER_TARGET_MESSAGE = "Only a System user can change a System user's login.";

/**
 * The one check before any act on another login's login (a password
 * reset, a disable or enable, a session end, a role change or a removal
 * from Admin, a device revoke, the company sign-in link, its personal
 * assistant, a delete): when
 * the target is a System user, the acting login must be one too. Your own
 * login is never refused. Null when the act may go on, else the 403 body
 * (code system_user_target). Used by every /api/users/:id act and by the
 * Admin workspace's user removal (lib/workspaces.ts); no MCP tool does
 * these acts (route-mcp-ledger: all planned).
 */
export async function systemUserTarget(
  actingId: string,
  targetId: string,
): Promise<SystemUserTargetRefused | null> {
  return (await systemUserTargetRefused(actingId, targetId))
    ? { error: SYSTEM_USER_TARGET_MESSAGE, code: 'system_user_target' }
    : null;
}

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
  return systemWork(async () => {
    // System missing (a brain with Admin whose System was lost): made
    // again by the migration's own step, every Admin user seated; a
    // no-op when it is there, or when the brain has no Admin. Run for no
    // app role, so as the migrator (executeAsMigrator, as the switch).
    await executeAsMigrator(sql`select "public"."mantle_ws_ensure_system"() as n`);
    return db.transaction(async (tx): Promise<SystemAddResult> => {
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
        // Made an Admin user here: what they shared or submitted as a
        // member goes back to private drafts, as the Users screen's role
        // change settles it (login-update.ts applyLoginChange).
        if (w === ws.admin) await settleSpaceOnPromotion(tx, login.id);
      }
      return {
        ok: true,
        addedToAdmin: !has.has(ws.admin),
        addedToSystem: !has.has(ws.system),
      };
    });
  }, 'system-add');
}
