import { authUsers, db, onFullSystemRoute, sql } from '@mantle/db';

/** The auth.users row a new login is made from. */
export type NewLoginRow = typeof authUsers.$inferInsert & { id: string };

/**
 * Insert a new login and put it in the workspace its role gives (an admin
 * login: the Admin workspace, as a Moderator; a member login: none,
 * mantle_bridge_login since 0286; the login bridge's trigger is off since
 * W5b2, its function stays, 0261), in ONE transaction: a login is never
 * left made without its workspace rows. Its private workspace is made the
 * first time it needs one; an Admin user adds it to any other. Errors (a
 * unique violation among them) are thrown as is, after the rollback. The
 * row names a role and a password hash, credential columns the narrow
 * login may not write: on a narrow exit the transaction runs at the
 * full-route spot login-credential (docs/runtime-role.md).
 */
export async function insertLoginWithWorkspaces(row: NewLoginRow): Promise<void> {
  await onFullSystemRoute('login-credential', () =>
    db.transaction(async (tx) => {
      await tx.insert(authUsers).values(row);
      await tx.execute(sql`select "public"."mantle_bridge_login"(${row.id}::uuid)`);
    }),
  );
}
