/**
 * Account reads: owner-scoped, for the Email reader's account list over
 * stored mail. Linking, probing and syncing an account left the brain
 * (Sync plan, M4): mail sync is rebuilt in the Sync service
 * (docs/services.md, "Sync"). Every function takes the owner `userId` and
 * scopes by it.
 */
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { db, emailAccounts, syncRuns, type EmailAccount, type SyncRun } from '@mantle/db';

/**
 * Build a stable ltree segment for an email account's branch path.
 *
 *   alex@example.com   → inbox.alex_3a1f
 *   alex@gmail.com     → inbox.alex_8b2c
 *
 * The 4-char hex suffix is a sha256 of the domain truncated; it keeps two
 * `alex@…` accounts on different providers from colliding under the same
 * `inbox.alex` path. ltree labels are restricted to [A-Za-z0-9_], hence the
 * explicit sanitisation of the local-part.
 */
export function accountBranchPath(address: string): string {
  const [local, domain] = address.toLowerCase().split('@');
  const cleanLocal = (local ?? '').replace(/[^a-z0-9]/g, '_').replace(/^_+|_+$/g, '') || 'account';
  const hash = createHash('sha256')
    .update(domain ?? '')
    .digest('hex')
    .slice(0, 4);
  return `inbox.${cleanLocal}_${hash}`;
}

/** An account with the sealed IMAP secret stripped — safe to send over HTTP. */
export type PublicEmailAccount = Omit<EmailAccount, 'imapConfigEnc'>;

// Key-set drift guards for the hand-mirrored wire DTOs in @mantle/client-types.
// Dates are ISO strings on the wire but `Date` here, so value types can't be
// compared — the key sets can, and renamed/added/removed columns fail here.
type AssertSameKeys<A, B> = [Exclude<keyof A, keyof B>, Exclude<keyof B, keyof A>] extends [
  never,
  never,
]
  ? true
  : { missingInDto: Exclude<keyof A, keyof B>; extraInDto: Exclude<keyof B, keyof A> };
const _publicEmailAccountDrift: AssertSameKeys<
  PublicEmailAccount,
  import('@mantle/client-types').PublicEmailAccount
> = true;
void _publicEmailAccountDrift;
const _syncRunDrift: AssertSameKeys<SyncRun, import('@mantle/client-types').SyncRun> = true;
void _syncRunDrift;

/** Drop the sealed credential before an account row crosses the HTTP boundary. */
export function redactAccount(account: EmailAccount): PublicEmailAccount {
  const { imapConfigEnc: _omit, ...rest } = account;
  return rest;
}

/** Every account for the owner, ordered by address (the settings list). */
export function listAccounts(userId: string): Promise<EmailAccount[]> {
  return db
    .select()
    .from(emailAccounts)
    .where(eq(emailAccounts.userId, userId))
    .orderBy(asc(emailAccounts.address));
}

/** One owner-scoped account, or null. */
export async function getAccount(userId: string, id: string): Promise<EmailAccount | null> {
  const [row] = await db
    .select()
    .from(emailAccounts)
    .where(and(eq(emailAccounts.id, id), eq(emailAccounts.userId, userId)))
    .limit(1);
  return row ?? null;
}

/**
 * The latest sync run per owner account, keyed by accountId. Mirrors the old
 * inline approach (fetch a window of recent runs, keep the first seen per
 * account) so behaviour is unchanged.
 */
export async function latestSyncRuns(userId: string): Promise<Map<string, SyncRun>> {
  const accounts = await db
    .select({ id: emailAccounts.id })
    .from(emailAccounts)
    .where(eq(emailAccounts.userId, userId));
  const latest = new Map<string, SyncRun>();
  if (accounts.length === 0) return latest;
  const recent = await db
    .select()
    .from(syncRuns)
    .where(
      inArray(
        syncRuns.accountId,
        accounts.map((a) => a.id),
      ),
    )
    .orderBy(desc(syncRuns.startedAt))
    .limit(accounts.length * 5);
  for (const r of recent) if (!latest.has(r.accountId)) latest.set(r.accountId, r);
  return latest;
}
