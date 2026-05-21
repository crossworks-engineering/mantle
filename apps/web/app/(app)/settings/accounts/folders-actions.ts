'use server';

import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import PgBoss from 'pg-boss';
import { db, emailAccounts } from '@mantle/db';
import { probeImapConnection, unsealImapPassword } from '@mantle/email';
import { requireOwner } from '@/lib/auth';

const SYNC_QUEUE = 'mantle.email.sync';

/** Lazy pg-boss publisher — one instance per web process. The actual sync
 *  worker runs in its own process; this just lets "save folder selection"
 *  enqueue an immediate rescan instead of waiting for the 2-minute scheduler.
 *  Mirrors the pattern in settings/senders/actions.ts. */
let _boss: PgBoss | undefined;
async function boss(): Promise<PgBoss> {
  if (_boss) return _boss;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must be set');
  _boss = new PgBoss({ connectionString: url, schema: 'pgboss' });
  await _boss.start();
  await _boss.createQueue(SYNC_QUEUE);
  return _boss;
}

export type AccountFoldersResult =
  | {
      ok: true;
      address: string;
      /** Every folder the server reports right now (the pick list). */
      allFolders: string[];
      /** The current explicit allow-list, or null = "scan all non-excluded". */
      included: string[] | null;
      /** Folders the operator opted OUT of (rendered disabled). */
      excluded: string[];
      /** Folders the sync has actually touched (per the cursor) — used to
       *  prefill checkboxes when there's no explicit include-list yet. */
      scanned: string[];
    }
  | { ok: false; error: string };

/** List the live folder tree for one IMAP account, plus its current scan
 *  config. Owner-scoped. Hits the IMAP server, so it can be slow/flaky —
 *  always returns a tagged result rather than throwing. */
export async function listAccountFolders(accountId: string): Promise<AccountFoldersResult> {
  const user = await requireOwner();
  const [account] = await db
    .select()
    .from(emailAccounts)
    .where(and(eq(emailAccounts.id, accountId), eq(emailAccounts.userId, user.id)))
    .limit(1);
  if (!account) return { ok: false, error: 'Account not found.' };
  if (account.provider !== 'imap' || !account.imapHost || !account.imapPort || !account.imapConfigEnc) {
    return { ok: false, error: 'This account has no IMAP connection to list folders from.' };
  }

  try {
    const pass = unsealImapPassword(account);
    const probe = await probeImapConnection({
      host: account.imapHost,
      port: account.imapPort,
      secure: account.imapSecure,
      user: account.address,
      pass,
    });
    const cursor = (account.syncState as { imap?: { folders?: Record<string, unknown> } } | null)?.imap;
    const scanned = cursor?.folders ? Object.keys(cursor.folders).sort() : [];
    return {
      ok: true,
      address: account.address,
      allFolders: probe.folders,
      included: account.imapIncludedFolders,
      excluded: account.imapExcludedFolders,
      scanned,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Persist the explicit folder allow-list for an account and kick an
 *  immediate rescan. Zero folders selected clears the list back to NULL
 *  (revert to "scan all non-excluded"). Owner-scoped; form-action shaped. */
export async function setIncludedFolders(formData: FormData): Promise<void> {
  const user = await requireOwner();
  const accountId = String(formData.get('accountId') ?? '');
  if (!accountId) return;

  // Dedup + drop blanks. Empty selection ⇒ NULL = legacy discover-minus-exclude.
  const folders = [...new Set(formData.getAll('folders').map(String).filter(Boolean))];

  const [account] = await db
    .select({ id: emailAccounts.id })
    .from(emailAccounts)
    .where(and(eq(emailAccounts.id, accountId), eq(emailAccounts.userId, user.id)))
    .limit(1);
  if (!account) return;

  await db
    .update(emailAccounts)
    .set({ imapIncludedFolders: folders.length > 0 ? folders : null, updatedAt: new Date() })
    .where(and(eq(emailAccounts.id, accountId), eq(emailAccounts.userId, user.id)));

  // Instant rescan: enqueue a sync for this account. singletonKey collapses
  // it with any sync the scheduler already queued. Best-effort — if the
  // worker/queue is down the scheduler still picks it up within ~2 min.
  try {
    const b = await boss();
    await b.send(SYNC_QUEUE, { accountId }, { singletonKey: `sync:${accountId}` });
  } catch (err) {
    console.error('[folders] enqueue immediate sync failed', err);
  }

  revalidatePath('/settings/accounts');
  revalidatePath(`/settings/accounts/${accountId}/folders`);
  revalidatePath('/inbox');
}
