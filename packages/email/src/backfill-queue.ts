/**
 * Backfill enqueue — the one place that publishes `mantle.email.backfill` jobs.
 *
 * Adding a contact email/domain should pull that sender's recent history into
 * the brain (mirrors the old approve→backfill). The work runs in the email-sync
 * worker (`apps/web/workers/email-sync.ts`); this is just the publisher, shared
 * by every caller that adds a contact entry: the web contacts API, the
 * discover-senders page, and the `contact_*` agent builtins. Keeping it here
 * (next to `backfillMatch`, with `@mantle/db` already available) means one
 * implementation and no duplicated pg-boss wiring.
 */
import PgBoss from 'pg-boss';
import { and, eq } from 'drizzle-orm';
import { db, emailAccounts } from '@mantle/db';

/** Queue name — must match the worker's `BACKFILL_QUEUE`. */
export const BACKFILL_QUEUE = 'mantle.email.backfill';

let _boss: PgBoss | undefined;
async function boss(): Promise<PgBoss> {
  if (_boss) return _boss;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must be set to enqueue a backfill');
  _boss = new PgBoss({ connectionString: url, schema: 'pgboss' });
  await _boss.start();
  await _boss.createQueue(BACKFILL_QUEUE);
  return _boss;
}

/**
 * Enqueue a 90-day backfill of `target` (a contact email entry — a full address
 * `alex@x.com` or a `@domain` wildcard) across every enabled account for the
 * owner. `singletonKey` collapses duplicate enqueues for the same target.
 * Best-effort: a queue hiccup must never make a contact write look failed, so
 * callers typically swallow errors.
 */
export async function enqueueBackfill(userId: string, target: string): Promise<void> {
  const t = target.trim();
  if (!t) return;
  const accounts = await db
    .select({ id: emailAccounts.id })
    .from(emailAccounts)
    .where(and(eq(emailAccounts.userId, userId), eq(emailAccounts.enabled, true)));
  if (accounts.length === 0) return;
  const b = await boss();
  for (const a of accounts) {
    await b.send(
      BACKFILL_QUEUE,
      { accountId: a.id, target: t },
      { singletonKey: `backfill:${a.id}:${t}` },
    );
  }
}

/** Enqueue backfills for a set of entries (e.g. `addedEmails` from a contact
 *  write). Best-effort + non-throwing — logs and continues. */
export async function enqueueBackfills(userId: string, targets: string[]): Promise<void> {
  for (const target of targets) {
    try {
      await enqueueBackfill(userId, target);
    } catch (err) {
      console.error('[email] enqueueBackfill failed', { target, err });
    }
  }
}
