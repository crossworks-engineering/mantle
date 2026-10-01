/**
 * The record of client quota refusals (client logins C5 audit, I5): every
 * time a client limit refuses a write, one row in client_quota_refusals with
 * the reason and the login, never a filename or a body. Team admin > Clients
 * lists the last 7 days, so an admin sees that the brain-wide total is full
 * before the clients tell them.
 *
 * Written on the admin pool (`asSystem`), outside the caller's transaction:
 * the refusal rolls the caller's work back, the record stays. Kept small on
 * every insert: rows older than 7 days go, and at most 500 are kept. A
 * failed record is logged and never masks the refusal itself.
 */
import { desc, gt, sql } from 'drizzle-orm';
import { asSystem, clientQuotaRefusals, db } from '@mantle/db';
import { errorMessage } from '@mantle/std';

/** Why a client write was refused (the admin card groups by it). */
export type ClientQuotaReason =
  | 'file-size'
  | 'storage'
  | 'total'
  | 'daily-upload'
  | 'upload-no-room'
  | 'items'
  | 'submits-per-day'
  | 'open-submissions'
  | 'comment-cap'
  | 'thread-full'
  | 'give-back';

/** How long refusals are kept, and at most how many. */
export const CLIENT_QUOTA_REFUSAL_DAYS = 7;
export const CLIENT_QUOTA_REFUSAL_ROWS = 500;

/** Record one refusal. Never throws. */
export async function recordClientQuotaRefusal(
  loginId: string | null,
  reason: ClientQuotaReason,
): Promise<void> {
  try {
    await asSystem(() =>
      db.transaction(async (tx) => {
        await tx.insert(clientQuotaRefusals).values({ loginId, reason });
        await tx.execute(sql`
          delete from client_quota_refusals
           where created_at < now() - make_interval(days => ${CLIENT_QUOTA_REFUSAL_DAYS})
              or id not in (select id from client_quota_refusals
                             order by created_at desc limit ${CLIENT_QUOTA_REFUSAL_ROWS})`);
      }),
    );
  } catch (err) {
    console.error('[client-quota] refusal not recorded:', errorMessage(err));
  }
}

export type ClientQuotaRefusal = { at: string; loginId: string | null; reason: string };

/** Refusals in the last 7 days, newest first, at most `limit`. Admin pool. */
export async function listClientQuotaRefusals(limit = 50): Promise<ClientQuotaRefusal[]> {
  const since = new Date(Date.now() - CLIENT_QUOTA_REFUSAL_DAYS * 24 * 3600 * 1000);
  const rows = await asSystem(() =>
    db
      .select({
        at: clientQuotaRefusals.createdAt,
        loginId: clientQuotaRefusals.loginId,
        reason: clientQuotaRefusals.reason,
      })
      .from(clientQuotaRefusals)
      .where(gt(clientQuotaRefusals.createdAt, since))
      .orderBy(desc(clientQuotaRefusals.createdAt))
      .limit(limit),
  );
  return rows.map((r) => ({ at: r.at.toISOString(), loginId: r.loginId, reason: r.reason }));
}
