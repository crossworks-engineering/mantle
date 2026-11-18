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
 * M3: the Microsoft app (microsoft_config, or the MS_* environment), each
 * connected Microsoft account with its tokens and its Outlook mail switch,
 * each drive with its chosen folders, and each drive's file map
 * (ms_drive_items into sync_items, 0382), under the same ids: the first
 * drive run re-links every file it already holds, it downloads none again.
 *
 * The old rows are left as they are (a later release drops their credential
 * columns). An account already in service_state is skipped, so a second run
 * changes nothing.
 *
 * Output is numbers only (no address, host or URL).
 *
 * Usage:
 *   pnpm -C server/web sync:copy-accounts           # DRY RUN: counts only
 *   pnpm -C server/web sync:copy-accounts --apply   # copy them
 */
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { env } from '@mantle/config';
import { open } from '@mantle/crypto';
import { errorMessage } from '@mantle/std';
import {
  calendarAccounts,
  closeDb,
  emailAccounts,
  getServiceState,
  getSyncItem,
  microsoftConfig,
  msAccounts,
  msDriveItems,
  msDrives,
  msDriveScopes,
  nodes,
  putServiceState,
  putSyncItem,
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

/** The Microsoft app (server/sync src/state.ts MsApp): the owner's
 *  microsoft_config row, else the MS_* environment, as before M4. */
async function copyMicrosoftApp(ownerId: string): Promise<Counts> {
  const c: Counts = { found: 0, copied: 0, already: 0, skipped: 0 };
  const [row] = await db
    .select()
    .from(microsoftConfig)
    .where(eq(microsoftConfig.ownerId, ownerId))
    .limit(1);
  let app: { clientId: string; clientSecret: string; tenant: string; redirectUri: string } | null =
    null;
  if (row) {
    c.found = 1;
    try {
      app = {
        clientId: row.clientId,
        clientSecret: open(row.clientSecretEnc, ownerId),
        tenant: row.tenant,
        redirectUri: row.redirectUri,
      };
    } catch {
      c.skipped = 1;
      return c;
    }
  } else if (env('MS_CLIENT_ID') && env('MS_CLIENT_SECRET')) {
    c.found = 1;
    const publicUrl = (env('MANTLE_PUBLIC_URL') ?? '').trim().replace(/\/+$/, '');
    const redirectUri =
      env('MS_REDIRECT_URI') || (publicUrl ? `${publicUrl}/api/microsoft/oauth/callback` : '');
    if (!/^https?:\/\//.test(redirectUri)) {
      c.skipped = 1;
      return c;
    }
    app = {
      clientId: env('MS_CLIENT_ID')!,
      clientSecret: env('MS_CLIENT_SECRET')!,
      tenant: env('MS_TENANT') || 'common',
      redirectUri,
    };
  }
  if (!app) return c;
  if (await getServiceState(SIDECAR_SERVICE, 'msapp')) {
    c.already = 1;
    return c;
  }
  if (apply) await putServiceState(SIDECAR_SERVICE, 'msapp', sealState('msapp', app));
  c.copied = 1;
  return c;
}

type MsCounts = { accounts: Counts; drives: Counts; files: Counts };

/** Each connected account (its tokens, its mail switch and watermark), its
 *  drives (their switch and chosen folders) and their file maps. */
async function copyMicrosoft(ownerId: string): Promise<MsCounts> {
  const zero = (): Counts => ({ found: 0, copied: 0, already: 0, skipped: 0 });
  const out: MsCounts = { accounts: zero(), drives: zero(), files: zero() };
  const accounts = await db.select().from(msAccounts).where(eq(msAccounts.userId, ownerId));
  for (const a of accounts) {
    out.accounts.found += 1;
    const key = `msaccount:${a.id}`;
    const known = !!(await getServiceState(SIDECAR_SERVICE, key));
    if (known) out.accounts.already += 1;
    else {
      const opened = (() => {
        try {
          return {
            accessToken: a.accessTokenEnc ? open(a.accessTokenEnc, a.id) : null,
            refreshToken: a.refreshTokenEnc ? open(a.refreshTokenEnc, a.id) : null,
          };
        } catch {
          return null;
        }
      })();
      if (!opened) {
        out.accounts.skipped += 1;
        continue;
      }
      const { accessToken, refreshToken } = opened;
      // Its Outlook mail: the companion mailbox row the mail switch made.
      const [mailbox] = await db
        .select()
        .from(emailAccounts)
        .where(and(eq(emailAccounts.userId, ownerId), eq(emailAccounts.msAccountId, a.id)))
        .limit(1);
      const account = {
        id: a.id,
        upn: a.upn,
        displayName: a.displayName,
        accessToken,
        refreshToken,
        expiresAt: a.tokenExpiresAt ? a.tokenExpiresAt.getTime() : null,
        scopes: a.scopes,
        branchPath: a.branchPath,
        mail: !!mailbox?.enabled,
        mailboxId: mailbox?.id ?? null,
        lastError: null,
      };
      const since = (mailbox?.syncState as { graph?: { mail?: { since?: unknown } } } | null)?.graph
        ?.mail?.since;
      if (apply) {
        await putServiceState(SIDECAR_SERVICE, key, sealState(key, account));
        if (mailbox && typeof since === 'string') {
          const ck = `mscursor:${a.id}`;
          await putServiceState(SIDECAR_SERVICE, ck, sealState(ck, { since }));
        }
      }
      out.accounts.copied += 1;
    }
    for (const d of await db.select().from(msDrives).where(eq(msDrives.accountId, a.id))) {
      out.drives.found += 1;
      const dk = `msdrive:${d.id}`;
      if (await getServiceState(SIDECAR_SERVICE, dk)) out.drives.already += 1;
      else {
        const scopes = await db
          .select()
          .from(msDriveScopes)
          .where(eq(msDriveScopes.driveDbId, d.id));
        const drive = {
          id: d.id,
          accountId: a.id,
          driveId: d.driveId,
          driveType: d.driveType,
          name: d.name,
          siteName: d.siteName,
          webUrl: d.webUrl,
          branchLabel: d.branchLabel,
          enabled: d.enabled,
          selections: scopes.map((s) => ({
            itemId: s.itemId,
            path: s.path,
            isFolder: s.isFolder,
            ...(s.name ? { name: s.name } : {}),
          })),
        };
        if (apply) await putServiceState(SIDECAR_SERVICE, dk, sealState(dk, drive));
        out.drives.copied += 1;
      }
      // The file map: each item to its node, with the node's size, so the
      // first run re-links an unchanged file instead of fetching it.
      const items = await db.select().from(msDriveItems).where(eq(msDriveItems.driveDbId, d.id));
      const sizes = new Map<string, number | null>();
      const ids = items.map((i) => i.nodeId);
      for (let i = 0; i < ids.length; i += 1000) {
        const rows = await db
          .select({ id: nodes.id, data: nodes.data })
          .from(nodes)
          .where(inArray(nodes.id, ids.slice(i, i + 1000)));
        for (const r of rows) {
          const n = (r.data as { sizeBytes?: unknown } | null)?.sizeBytes;
          sizes.set(r.id, typeof n === 'number' ? n : null);
        }
      }
      for (const it of items) {
        out.files.found += 1;
        if (await getSyncItem(SIDECAR_SERVICE, d.id, it.itemId)) {
          out.files.already += 1;
          continue;
        }
        if (!sizes.has(it.nodeId)) {
          out.files.skipped += 1;
          continue;
        }
        if (apply) {
          await putSyncItem(SIDECAR_SERVICE, d.id, {
            itemId: it.itemId,
            nodeId: it.nodeId,
            hash: null,
            size: sizes.get(it.nodeId) ?? null,
            modTime: it.lastModified,
          });
        }
        out.files.copied += 1;
      }
    }
  }
  return out;
}

const line = (what: string, c: Counts) =>
  `[sync-copy-accounts] ${what}: ${c.found} found, ${c.copied} ${apply ? 'copied' : 'to copy'}, ${c.already} already in Sync, ${c.skipped} skipped (no settings, or a seal that does not open)`;

async function main() {
  const ownerId = env('ALLOWED_USER_ID') || (await resolveSingleOwnerId());
  if (!ownerId) throw new Error('no owner on this box');
  const [mail, feeds, app, ms] = await runAsSystem(
    'backfill:sync-copy-accounts',
    async () =>
      [
        await copyMailboxes(ownerId),
        await copyFeeds(ownerId),
        await copyMicrosoftApp(ownerId),
        await copyMicrosoft(ownerId),
      ] as const,
  );
  console.log(line('mailboxes', mail));
  console.log(line('calendar feeds', feeds));
  console.log(line('Microsoft app', app));
  console.log(line('Microsoft accounts', ms.accounts));
  console.log(line('Microsoft drives', ms.drives));
  console.log(line('synced files (the file map)', ms.files));
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
