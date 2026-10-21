/**
 * The first owner's switch onto workspaces (the plan names the signup's first
 * owner as a caller of its own, actor system(first-owner-attach)): the one
 * request system exit a request no login made may take, inside POST
 * /api/auth/signup only.
 *
 * A fresh install has no owner and no workspaces; its signup makes the
 * owner (server/web/lib/auth/first-owner.ts) and then switches the brain
 * (mantle_ws_migrate_locked, through executeAsMigrator), the switch the boot
 * runs as systemWork('boot:migrate-workspaces'). systemWork refuses a
 * request, and the request's own actor, system(http:no-login), names no
 * work, so the switch takes this exit: system(first-owner-attach) on the
 * full route (viewer.ts REQUEST_SYSTEM_ROUTE 'first-owner'), for that one
 * call. The exit runs the switch itself and nothing else: it takes no
 * function, so no caller can run other work as this actor. It refuses,
 * before the switch runs:
 *  - anywhere but a request no login made, outside every scope, once per
 *    request (viewer.ts enterFirstOwnerExit);
 *  - on a brain whose logins are not exactly `loginId`, the anchor, or
 *    that has a workspace: the brain the signup just gave its first owner,
 *    still off workspaces. A brain with an owner never reaches it (the
 *    signup answers 403 first), nor one already switched. That check runs
 *    in the switch's own transaction (executeAsMigrator's guard), so the
 *    brain it reads is the one the switch then works on in that
 *    transaction.
 * The SQL allowlist of workspace system work (mantle_ws_system_work) does
 * not name this actor: the switch calls none of its definers, and the
 * assistant attach that follows runs in the new owner's own scope
 * (workspaces-migrate.ts attachDefaultAssistants), outside this exit.
 */
import { sql } from 'drizzle-orm';
import { RuntimeFaultError, UUID_RE } from '@mantle/std';
import { executeAsMigrator } from './client';
import { enterFirstOwnerExit } from './viewer';

/** A row of the workspaces switch (mantle_ws_migrate_locked). */
export type FirstOwnerSwitchRow = { section: string; subject: string; metric: string; n: number };

/** Switch the brain onto workspaces as the first owner's exit (see the
 *  top): the same call the boot runs, mantle_ws_migrate_locked through
 *  executeAsMigrator, and nothing else. */
export function firstOwnerSwitch(loginId: string): Promise<FirstOwnerSwitchRow[]> {
  return enterFirstOwnerExit(async () => {
    if (typeof loginId !== 'string' || !UUID_RE.test(loginId)) {
      throw new RuntimeFaultError("the first owner's exit refused: not a login id");
    }
    const rows = await executeAsMigrator<FirstOwnerSwitchRow>(
      sql`select * from "public"."mantle_ws_migrate_locked"()`,
      {
        sql: sql`
          select (select count(*) from auth.users) = 1
             and exists (select 1 from auth.users where id = ${loginId}::uuid and is_owner)
             and not exists (select 1 from "public"."workspaces") as ok`,
        refusal:
          "the first owner's exit refused: only on a brain whose one login is this new owner, with no workspaces yet",
      },
    );
    return rows.map((r) => ({ ...r, n: Number(r.n) }));
  });
}
