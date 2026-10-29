/**
 * The Admin seat, asked one way: who is
 * an Admin user, and which workspace is the brain's live Admin one.
 *
 * In SQL the one base read is mantle_admin_seat(login) (0330), which
 * mantle_login_is_admin, mantle_area_rule, mantle_login_role and
 * mantle_scope_admin_facts wrap. In TypeScript every caller asks through
 * these three:
 *  - loginIsAdmin(id): the SQL column "a user of the live Admin workspace
 *    now, the login enabled" (mantle_login_is_admin), for a select or a
 *    filter that decides: the login row (login-row.ts, so the session's
 *    resolvedFor and adminLogin), the token login, the pair code, the OAuth
 *    grants and ownerFromBearer, a peer's bound login, the admin push
 *    devices.
 *  - loginRole(id): the SQL column of the display role, 'admin' for any
 *    user of the live Admin workspace (enabled or not, a disabled login
 *    shows its own flag), else 'member' (mantle_login_role). Decides
 *    nothing: what a login is called in an answer or a list (the token
 *    login's and the pair code's answer, the Users screen's target and
 *    list, the admin device list).
 *  - liveAdminWorkspace(tx): the brain's live Admin workspace (its owner
 *    and id) and whether a login is a user of it, for the two places that
 *    add to or remove from it through the membership definers (the admin
 *    login create, the Users screen's role change).
 * The role column is never asked: it follows membership, written only by
 * the membership definers (and the role guard refuses any other writer).
 */
import type { SQL, SQLWrapper } from 'drizzle-orm';
import { liveWorkspaceSql, sql, type LoginRole } from '@mantle/db';

/** "A user of the brain's live Admin workspace now, the login enabled"
 *  for login `id` (a bound id or a column): mantle_login_is_admin. */
export function loginIsAdmin(id: SQLWrapper | string): SQL<boolean> {
  return sql<boolean>`"public"."mantle_login_is_admin"(${id}::uuid)`;
}

/** The display role of login `id` (a bound id or a column): 'admin' for
 *  any user of the brain's live Admin workspace, else 'member'
 *  (mantle_login_role). Never a decision: decisions ask loginIsAdmin. */
export function loginRole(id: SQLWrapper | string): SQL<LoginRole> {
  return sql<LoginRole>`"public"."mantle_login_role"(${id}::uuid)`;
}

/** Anything that runs a statement: a transaction or a pool. */
type Exec = { execute(query: SQL): PromiseLike<unknown> };

/** The brain's live Admin workspace, and whether `loginId` is a user of it
 *  (any row, enabled or not, as the definers see it). Null when there is
 *  none, or (a corrupt state) more than one. */
export async function liveAdminWorkspace(
  tx: Exec,
  loginId?: string,
): Promise<{ owner: string; ws: string; member: boolean } | null> {
  const rows = (await tx.execute(sql`
    select w."owner_id" as owner, w."id" as ws,
           ${
             loginId === undefined
               ? sql`false`
               : sql`exists (select 1 from "public"."workspace_users" u
                              where u."workspace_id" = w."id" and u."login_id" = ${loginId}::uuid)`
           } as member
      from "public"."workspaces" w
     where w."owner_id" = "public"."mantle_brain_id"() and w."is_admin"
       and ${liveWorkspaceSql('w')}`)) as unknown as {
    owner: string;
    ws: string;
    member: boolean;
  }[];
  return rows.length === 1 ? rows[0]! : null;
}
