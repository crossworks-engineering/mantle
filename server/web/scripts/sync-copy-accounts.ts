/**
 * Copy the mailboxes and calendar feeds the old sync left behind into the
 * Sync service (Sync service plan M2: the `sync-copy-accounts` maintenance
 * task). Before M4 each IMAP mailbox kept its settings and sealed app
 * password on its `email_accounts` row and each ICS feed its sealed URL on
 * its `calendar_accounts` row. The Sync sidecar keeps them in service_state
 * (0380). This copies each one there under the SAME id, so stored mail stays
 * linked to its mailbox and stored events to their feed. No new password,
 * no new consent.
 *
 * The old rows are left as they are (a later release drops their credential
 * columns). An account already in service_state is skipped, so a second run
 * changes nothing. Microsoft accounts are not copied here (M3).
 *
 * Output is numbers only (no address, host or URL).
 *
 * Usage:
 *   pnpm -C server/web sync:copy-accounts           # DRY RUN: counts only
 *   pnpm -C server/web sync:copy-accounts --apply   # copy them
 */
import { and, eq, isNotNull } from 'drizzle-orm';
import { env } from '@mantle/config';
import { open } from '@mantle/crypto';
import { errorMessage } from '@mantle/std';
import {
  calendarAccounts,
  closeDb,
  emailAccounts,
  getServiceState,
  putServiceState,
  resolveSingleOwnerId,
  runAsSystem,
  db,
} from '@mantle/db';
import { SIDECAR_SERVICE, sealState } from '../lib/sidecar-state';

if (!env('DATABASE_URL')) {
  console.error('sync-copy-accounts: DATABASE_URL must be set');
  process.exit(1);
}
if (!env('MANTLE_MASTER_KEY')) {
  console.error(
    'sync-copy-accounts: MANTLE_MASTER_KEY must be set (the old passwords are sealed with it)',
  );
  process.exit(1);
}

const apply = process.argv.slice(2).includes('--apply');

/** The mailbox shape the sidecar keeps (server/sync src/state.ts MailAccount). */
type MailAccountState = {
  id: string;
  address: string;
  displayName: string | null;
  imap: { host: string; port: number; secure: boolean };
  smtp: { host: string; port: number; secure: boolean } | null;
  password: string;
  firstScanDays: number;
  excludedFolders: string[];
  includedFolders: string[] | null;
  enabled: boolean;
};

type Counts = { found: number; copied: number; already: number; skipped: number };

async function copyMailboxes(ownerId: string): Promise<Counts> {
  const rows = await db
    .select()
    .from(emailAccounts)
    .where(and(eq(emailAccounts.userId, ownerId), eq(emailAccounts.provider, 'imap')));
  const c: Counts = { found: rows.length, copied: 0, already: 0, skipped: 0 };
  for (const row of rows) {
    const key = `account:${row.id}`;
    if (await getServiceState(SIDECAR_SERVICE, key)) {
      c.already += 1;
      continue;
    }
    if (!row.imapConfigEnc || !row.imapHost || !row.imapPort) {
      c.skipped += 1;
      continue;
    }
    let password: string;
    try {
      ({ password } = JSON.parse(open(row.imapConfigEnc, `imap:${row.userId}:${row.address}`)) as {
        password: string;
      });
    } catch {
      c.skipped += 1;
      continue;
    }
    const account: MailAccountState = {
      id: row.id,
      address: row.address,
      displayName: row.displayName,
      imap: { host: row.imapHost, port: row.imapPort, secure: row.imapSecure },
      smtp:
        row.smtpHost && row.smtpPort
          ? { host: row.smtpHost, port: row.smtpPort, secure: row.smtpSecure }
          : null,
      password,
      firstScanDays: row.firstScanDays,
      excludedFolders: row.imapExcludedFolders,
      includedFolders:
        row.imapIncludedFolders && row.imapIncludedFolders.length > 0
          ? row.imapIncludedFolders
          : null,
      enabled: row.enabled,
    };
    // The old cursor, so the first run goes on where the old sync stopped.
    const folders = (row.syncState as { imap?: { folders?: unknown } } | null)?.imap?.folders;
    if (apply) {
      await putServiceState(SIDECAR_SERVICE, key, sealState(key, account));
      if (folders && typeof folders === 'object') {
        const ck = `cursor:${row.id}`;
        await putServiceState(SIDECAR_SERVICE, ck, sealState(ck, { folders }));
      }
    }
    c.copied += 1;
  }
  return c;
}

async function copyFeeds(ownerId: string): Promise<Counts> {
  const rows = await db
    .select()
    .from(calendarAccounts)
    .where(
      and(
        eq(calendarAccounts.ownerId, ownerId),
        eq(calendarAccounts.provider, 'ics'),
        isNotNull(calendarAccounts.feedUrlEnc),
      ),
    );
  const c: Counts = { found: rows.length, copied: 0, already: 0, skipped: 0 };
  for (const row of rows) {
    const key = `feed:${row.id}`;
    if (await getServiceState(SIDECAR_SERVICE, key)) {
      c.already += 1;
      continue;
    }
    let url: string;
    try {
      url = open(row.feedUrlEnc!, row.id);
    } catch {
      c.skipped += 1;
      continue;
    }
    if (apply) {
      await putServiceState(
        SIDECAR_SERVICE,
        key,
        sealState(key, { id: row.id, name: row.displayName, url, enabled: row.enabled }),
      );
    }
    c.copied += 1;
  }
  return c;
}

const line = (what: string, c: Counts) =>
  `[sync-copy-accounts] ${what}: ${c.found} found, ${c.copied} ${apply ? 'copied' : 'to copy'}, ${c.already} already in Sync, ${c.skipped} skipped (no settings, or a seal that does not open)`;

async function main() {
  const ownerId = env('ALLOWED_USER_ID') || (await resolveSingleOwnerId());
  if (!ownerId) throw new Error('no owner on this box');
  const [mail, feeds] = await runAsSystem('backfill:sync-copy-accounts', () =>
    Promise.all([copyMailboxes(ownerId), copyFeeds(ownerId)]),
  );
  console.log(line('mailboxes', mail));
  console.log(line('calendar feeds', feeds));
  if (!apply) console.log('[sync-copy-accounts] DRY RUN: pass --apply to copy them');
}

main()
  .then(async () => {
    await closeDb().catch(() => {});
    process.exit(0);
  })
  .catch((err) => {
    console.error('[sync-copy-accounts] failed:', errorMessage(err));
    process.exit(1);
  });
