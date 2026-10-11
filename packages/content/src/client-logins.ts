/**
 * Client logins (client logins, plan section 4). A CLIENT login has no
 * password: it signs in with an emailed code (client-codes.ts). Workspaces
 * W5c removed the client portal, the admin-issued sign-in links and the Team
 * admin client routes (making and listing client logins); what is left here
 * is what the kept code sign-in and the login lifecycle still need.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { authUsers, clientSigninCodes, db } from '@mantle/db';
import { asSystem } from '@mantle/db/viewer';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Exec = Tx | typeof db;

/**
 * Whether a queued client turn may still run (client logins C4, plan section
 * 4): the login is an active client and its session epoch is the one the
 * turn was queued under, so a sign-out everywhere, an admin's End sessions or
 * Disable stops a turn still waiting on the queue. Read as the system (the
 * turn itself runs on the client role, which reads no auth.users rows).
 */
export async function clientTurnMayRun(loginId: string, epoch: number): Promise<boolean> {
  const row = await asSystem(() => activeClient(db, loginId));
  return !!row && row.sessionEpoch === epoch;
}

/** The client login `loginId`, when it is an ACTIVE client (not disabled). */
async function activeClient(
  exec: Exec,
  loginId: string,
): Promise<{ id: string; email: string; sessionEpoch: number } | null> {
  const [row] = await exec
    .select({
      id: authUsers.id,
      email: authUsers.email,
      role: authUsers.role,
      disabledAt: authUsers.disabledAt,
      sessionEpoch: authUsers.sessionEpoch,
    })
    .from(authUsers)
    .where(eq(authUsers.id, loginId))
    .limit(1);
  if (!row || row.role !== 'client' || row.disabledAt !== null || !row.email) return null;
  return { id: row.id, email: row.email, sessionEpoch: row.sessionEpoch };
}

/**
 * Revoke EVERY open way in the login still holds: its unused sign-in links
 * and its unused emailed codes alike (client logins audit B14). Disabling a
 * login and ending its sessions call this in the same transaction, so a
 * link issued before cannot come back when the login is enabled again, and
 * "End sessions" leaves nothing to sign straight back in with. Returns how
 * many it revoked.
 */
export async function revokeOpenClientSignins(
  exec: Exec,
  loginId: string,
  now = new Date(),
): Promise<number> {
  const rows = await exec
    .update(clientSigninCodes)
    .set({ revokedAt: now })
    .where(
      and(
        eq(clientSigninCodes.loginId, loginId),
        isNull(clientSigninCodes.usedAt),
        isNull(clientSigninCodes.revokedAt),
      ),
    )
    .returning({ id: clientSigninCodes.id });
  return rows.length;
}
