/**
 * The Admin seat, asked one way (plan v3.2 S8b, the gateway lens): who is
 * an Admin user, and which workspace is the brain's live Admin one.
 *
 * In SQL the one base read is mantle_admin_seat(login) (0330), which
 * mantle_login_is_admin, mantle_area_rule, mantle_login_role and
 * mantle_scope_admin_facts wrap. In TypeScript every caller asks through
 * these two:
 *  - loginIsAdmin(id): the SQL column "a user of the live Admin workspace
 *    now, the login enabled" (mantle_login_is_admin), for a select or a
 *    filter: the login row (login-row.ts, so the session's resolvedFor and
 *    adminLogin), the token login, the pair code, the OAuth grants and
 *    ownerFromBearer, a peer's bound login.
 *  - liveAdminWorkspace(tx): the brain's live Admin workspace (its owner
 *    and id) and whether a login is a user of it, for the two places that
 *    add to or remove from it through the membership definers (the admin
 *    login create, the Users screen's role change).
 * The role column is never asked: it follows membership, written only by
 * the membership definers (and the role guard refuses any other writer).
 */
import type { SQL, SQLWrapper } from 'drizzle-orm';
import { liveWorkspaceSql, sql } from '@mantle/db';

/** "A user of the brain's live Admin workspace now, the login enabled"
 *  for login `id` (a bound id or a column): mantle_login_is_admin. */
export function loginIsAdmin(id: SQLWrapper | string): SQL<boolean> {
  return sql<boolean>`"public"."mantle_login_is_admin"(${id}::uuid)`;
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
