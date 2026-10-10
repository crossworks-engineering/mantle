import { authUsers, db, sql } from '@mantle/db';

/** The auth.users row a new login is made from. */
export type NewLoginRow = typeof authUsers.$inferInsert & { id: string };

/**
 * Insert a new login and put it in the workspaces its role gives (the
 * Admin and Team rows, mantle_bridge_login; the login bridge's trigger is
 * off since W5b2, its function stays, 0261), in ONE transaction: a login is
 * never left made without its workspace rows. Errors (a unique violation
 * among them) are thrown as is, after the rollback.
 */
export async function insertLoginWithWorkspaces(row: NewLoginRow): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(authUsers).values(row);
    await tx.execute(sql`select "public"."mantle_bridge_login"(${row.id}::uuid)`);
  });
}
