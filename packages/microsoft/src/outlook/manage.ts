/**
 * Manage the companion `email_accounts` row that wires a connected Microsoft
 * account into the email pipeline. Mail is opt-in (like drives): toggling it on
 * creates/enables the row; off disables it. The row carries `provider:
 * 'microsoft'` + `ms_account_id` so the Microsoft worker (not the IMAP worker)
 * syncs it via the Graph provider.
 */
import { and, eq } from 'drizzle-orm';
import { db, emailAccounts, msAccounts, type EmailAccount } from '@mantle/db';

/** The companion mailbox account for an MS account, if one exists. */
export async function getMailAccount(ownerId: string, msAccountId: string): Promise<EmailAccount | null> {
  const [row] = await db
    .select()
    .from(emailAccounts)
    .where(and(eq(emailAccounts.userId, ownerId), eq(emailAccounts.msAccountId, msAccountId)))
    .limit(1);
  return row ?? null;
}

/** Create (or re-enable) the companion mailbox account for an MS account.
 *  Returns false if the MS account isn't owned by `ownerId`. */
export async function ensureMailAccount(ownerId: string, msAccountId: string): Promise<boolean> {
  const [ms] = await db
    .select()
    .from(msAccounts)
    .where(and(eq(msAccounts.id, msAccountId), eq(msAccounts.userId, ownerId)))
    .limit(1);
  if (!ms) return false;

  await db
    .insert(emailAccounts)
    .values({
      userId: ownerId,
      provider: 'microsoft',
      address: ms.upn,
      displayName: ms.displayName ?? null,
      branchPath: `${ms.branchPath}.mail`,
      msAccountId: ms.id,
      enabled: true,
    })
    .onConflictDoUpdate({
      target: [emailAccounts.userId, emailAccounts.address],
      set: {
        provider: 'microsoft',
        msAccountId: ms.id,
        displayName: ms.displayName ?? null,
        enabled: true,
        lastSyncError: null,
        updatedAt: new Date(),
      },
    });
  return true;
}

/** Turn mail sync on/off for an MS account. */
export async function setMailEnabled(ownerId: string, msAccountId: string, enabled: boolean): Promise<boolean> {
  if (enabled) return ensureMailAccount(ownerId, msAccountId);
  await db
    .update(emailAccounts)
    .set({ enabled: false, updatedAt: new Date() })
    .where(and(eq(emailAccounts.userId, ownerId), eq(emailAccounts.msAccountId, msAccountId)));
  return true;
}
