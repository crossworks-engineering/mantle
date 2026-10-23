import { authUsers, db, onFullSystemRoute, sql } from '@mantle/db';
import { liveAdminWorkspace } from '@/lib/auth/admin-seat';

/** The auth.users row a new login is made from. */
export type NewLoginRow = typeof authUsers.$inferInsert & { id: string };

/**
 * Insert a new login, in ONE transaction with what its role gives: a member
 * login joins no workspace (0286; its private workspace is made the first
 * time it needs one, an Admin user adds it to any other); an admin login is
 * a user of the Admin workspace, a Moderator there. Membership decides the
 * role, so the admin login is inserted as a member and added to Admin
 * through the membership definer (mantle_ws_add_user), which writes the
 * role 'admin' in the same transaction. The add is the caller's: the
 * Users screen's Admin area exit, whose acting login the gateway sends;
 * with no scope the definer takes that login, checks it is an Admin user
 * with the users area, as on the workspace screen, and names it on the
 * event row. A login is never left made without its Admin row. Errors (a
 * unique violation, a definer's refusal) are thrown as is, after the
 * rollback. The row names a password hash, and the add writes the role, a
 * credential column the narrow login may not write: on a narrow exit both
 * branches run at the full-route spot login-credential
 * (docs/runtime-role.md).
 */
export async function insertLoginWithWorkspaces(row: NewLoginRow): Promise<void> {
  await onFullSystemRoute('login-credential', () =>
    db.transaction(async (tx) => {
      if (row.role !== 'admin') {
        await tx.insert(authUsers).values(row);
        return;
      }
      await tx.insert(authUsers).values({ ...row, role: 'member' });
      const admin = await liveAdminWorkspace(tx);
      if (!admin) {
        throw new Error('insertLoginWithWorkspaces: the brain has no live Admin workspace');
      }
      await tx.execute(
        sql`select "public"."mantle_ws_add_user"(${admin.owner}::uuid, ${admin.ws}::uuid, ${row.id}::uuid, true)`,
      );
    }),
  );
}
