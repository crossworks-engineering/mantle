/**
 * Account data layer — owner-scoped reads/writes for email accounts.
 *
 * Lifted out of `server/web` (the settings/accounts pages + IMAP form action) so
 * the same logic is reachable both in-process (SSR) and over HTTP (`/api/email`)
 * and by any non-Next consumer. Every function takes the owner `userId` and
 * scopes by it — a stolen account UUID can never touch another owner's row.
 */
import { createHash } from 'node:crypto';
import { PgBoss } from 'pg-boss';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import {
  clientSigninSenderFolders,
  db,
  emailAccounts,
  syncRuns,
  type EmailAccount,
  type SyncRun,
} from '@mantle/db';
import { seal } from '@mantle/crypto';
import { probeImapConnection, unsealImapPassword } from './providers/imap';
import { probeSmtpConnection } from './send';
import { pickSentFolders } from './client-code-mail';
import type { AccountFoldersResult } from '@mantle/client-types';
import { env } from '@mantle/config';
import { errorMessage } from '@mantle/std';

export type { AccountFoldersResult };

/** Immediate-rescan queue — must match the email-sync worker's queue name. */
const SYNC_QUEUE = 'mantle.email.sync';

let _boss: PgBoss | undefined;
async function boss(): Promise<PgBoss> {
  if (_boss) return _boss;
  const url = env('DATABASE_URL');
  if (!url) throw new Error('DATABASE_URL must be set');
  _boss = new PgBoss({ connectionString: url, schema: 'pgboss' });
  await _boss.start();
  await _boss.createQueue(SYNC_QUEUE);
  return _boss;
}

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

/** Enabled IMAP accounts for the owner (discover/backfill callers). */
export function listImapAccounts(
  userId: string,
  opts?: { enabledOnly?: boolean },
): Promise<EmailAccount[]> {
  const conds = [eq(emailAccounts.userId, userId), eq(emailAccounts.provider, 'imap')];
  if (opts?.enabledOnly) conds.push(eq(emailAccounts.enabled, true));
  return db
    .select()
    .from(emailAccounts)
    .where(and(...conds));
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

export interface SaveImapAccountInput {
  /** Present = edit an existing (owner-scoped) account. */
  accountId?: string;
  /** Effective address. On create this is the new identity; on edit it's the
   *  stored address (the account identity is never changed). */
  address: string;
  displayName?: string | null;
  host: string;
  port: number;
  secure: boolean;
  smtpHost?: string | null;
  smtpPort?: number | null;
  smtpSecure: boolean;
  firstScanDays: number;
  /** Plaintext password to STORE (sealed). On create: required. On edit: provide
   *  ONLY to rotate the stored password; omit to keep the existing one. */
  password?: string;
}

export type SaveImapAccountResult = { ok: true; id: string } | { ok: false; error: string };

/**
 * Create or update an IMAP account (the persistence half of the connect form).
 * Probing the connection is the caller's job — this only seals + writes. The
 * seal AAD is bound to `imap:${userId}:${address}` so a re-seal on edit reuses
 * the unchanged stored address.
 */
export async function saveImapAccount(
  userId: string,
  input: SaveImapAccountInput,
): Promise<SaveImapAccountResult> {
  const {
    accountId,
    address,
    displayName,
    host,
    port,
    secure,
    smtpHost,
    smtpPort,
    smtpSecure,
    firstScanDays,
    password,
  } = input;

  if (accountId) {
    const existing = await getAccount(userId, accountId);
    if (!existing) return { ok: false, error: 'Account not found.' };
    await db
      .update(emailAccounts)
      .set({
        imapHost: host,
        imapPort: port,
        imapSecure: secure,
        smtpHost: smtpHost ?? null,
        smtpPort: smtpPort ?? null,
        smtpSecure,
        displayName: displayName ?? null,
        firstScanDays,
        enabled: true,
        lastSyncError: null,
        updatedAt: new Date(),
        // Re-seal only when a new password was supplied (AAD bound to the
        // unchanged stored address).
        ...(password
          ? {
              imapConfigEnc: seal(
                JSON.stringify({ password }),
                `imap:${userId}:${existing.address}`,
              ).ciphertext,
            }
          : {}),
      })
      .where(and(eq(emailAccounts.id, existing.id), eq(emailAccounts.userId, userId)));
    return { ok: true, id: existing.id };
  }

  if (!password) return { ok: false, error: 'App password is required.' };
  const sealed = seal(JSON.stringify({ password }), `imap:${userId}:${address}`);
  const [row] = await db
    .insert(emailAccounts)
    .values({
      userId,
      provider: 'imap',
      address,
      displayName: displayName ?? null,
      imapHost: host,
      imapPort: port,
      imapSecure: secure,
      smtpHost: smtpHost ?? null,
      smtpPort: smtpPort ?? null,
      smtpSecure,
      imapConfigEnc: sealed.ciphertext,
      ingestPolicy: 'approve_list',
      branchPath: accountBranchPath(address),
      firstScanDays,
    })
    .onConflictDoUpdate({
      target: [emailAccounts.userId, emailAccounts.address],
      set: {
        imapHost: host,
        imapPort: port,
        imapSecure: secure,
        smtpHost: smtpHost ?? null,
        smtpPort: smtpPort ?? null,
        smtpSecure,
        imapConfigEnc: sealed.ciphertext,
        firstScanDays,
        enabled: true,
        lastSyncError: null,
        // branchPath is *not* reset on re-connect — preserves the existing
        // ltree location for any mail already ingested under it.
      },
    })
    .returning({ id: emailAccounts.id });
  return { ok: true, id: row!.id };
}

/** Tighten a few common IMAP/SMTP errors into plain English. */
export function explainImapError(err: unknown): string {
  const raw = errorMessage(err);
  if (/authentication/i.test(raw))
    return 'Authentication failed — check the email address and app password.';
  if (/ENOTFOUND|EAI_AGAIN/i.test(raw)) return 'Could not resolve that host. Check the IMAP host.';
  if (/ECONNREFUSED/i.test(raw))
    return "Connection refused — wrong port, or the server isn't listening there.";
  if (/ETIMEDOUT|timeout/i.test(raw))
    return 'Timed out connecting. Check the host, port, and TLS toggle.';
  if (/self.signed certificate|unable to verify/i.test(raw))
    return 'TLS certificate problem. If you trust this host, try toggling TLS off and using a STARTTLS port.';
  return raw;
}

export interface ConnectImapInput {
  /** Present = edit an existing account; the stored address stays the identity. */
  accountId?: string;
  /** Required on create. */
  address?: string;
  displayName?: string | null;
  host: string;
  port: number;
  secure: boolean;
  /** Blank on edit = keep the stored password; required on create. */
  password?: string;
  firstScanDays: number;
  smtpHost?: string | null;
  smtpPort?: number | null;
  smtpSecure: boolean;
}

export type ConnectImapResult =
  | { intent: 'test'; ok: true; foldersFound: number; folderSample: string[]; serverName?: string }
  | { intent: 'save'; ok: true; id: string }
  | { ok: false; error: string };

/**
 * The full connect flow shared by the settings form action and the
 * `/api/email/accounts` endpoint: resolve the password, probe IMAP (and SMTP if
 * configured), then either report the probe (`test`) or persist (`save`). Always
 * probes — for `test` it's the point, for `save` it's a typo guardrail. Errors
 * are tagged, never thrown, so both callers can render them uniformly.
 */
export async function connectImapAccount(
  userId: string,
  intent: 'test' | 'save',
  input: ConnectImapInput,
): Promise<ConnectImapResult> {
  const existing = input.accountId ? await getAccount(userId, input.accountId) : null;
  if (input.accountId && !existing) return { ok: false, error: 'Account not found.' };

  const effectiveAddress = existing?.address ?? input.address;
  if (!effectiveAddress) return { ok: false, error: 'Email address is required.' };

  // Resolve the password to probe/save with. On edit a blank field reuses the
  // stored one; on create it's required.
  let effectivePassword = input.password;
  if (!effectivePassword) {
    if (existing) {
      try {
        effectivePassword = unsealImapPassword(existing);
      } catch {
        return {
          ok: false,
          error: 'Stored password could not be read — re-enter the app password.',
        };
      }
    } else {
      return { ok: false, error: 'App password is required.' };
    }
  }

  let probe;
  try {
    probe = await probeImapConnection({
      host: input.host,
      port: input.port,
      secure: input.secure,
      user: effectiveAddress,
      pass: effectivePassword,
    });
  } catch (err) {
    return { ok: false, error: explainImapError(err) };
  }

  if (input.smtpHost && input.smtpPort) {
    try {
      await probeSmtpConnection({
        host: input.smtpHost,
        port: input.smtpPort,
        secure: input.smtpSecure,
        user: effectiveAddress,
        pass: effectivePassword,
      });
    } catch (err) {
      return { ok: false, error: `SMTP: ${explainImapError(err)}` };
    }
  }

  if (intent === 'test') {
    return {
      intent: 'test',
      ok: true,
      foldersFound: probe.folders.length,
      // A handful so the user can confirm it's their account, not someone else's.
      folderSample: probe.folders.slice(0, 6),
      serverName: probe.serverGreeting,
    };
  }

  const saved = await saveImapAccount(userId, {
    accountId: existing?.id,
    address: effectiveAddress,
    displayName: input.displayName,
    host: input.host,
    port: input.port,
    secure: input.secure,
    smtpHost: input.smtpHost,
    smtpPort: input.smtpPort,
    smtpSecure: input.smtpSecure,
    firstScanDays: input.firstScanDays,
    // Edit: reseal only if a new password was typed. Create: seal the resolved one.
    password: existing ? input.password : effectivePassword,
  });
  if (!saved.ok) return saved;
  return { intent: 'save', ok: true, id: saved.id };
}

/**
 * List the live folder tree for one IMAP account, plus its current scan config.
 * Owner-scoped. Hits the IMAP server, so it can be slow/flaky — always returns
 * a tagged result rather than throwing.
 */
export async function listAccountFolders(
  userId: string,
  accountId: string,
): Promise<AccountFoldersResult> {
  const account = await getAccount(userId, accountId);
  if (!account) return { ok: false, error: 'Account not found.' };
  if (
    account.provider !== 'imap' ||
    !account.imapHost ||
    !account.imapPort ||
    !account.imapConfigEnc
  ) {
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
    const cursor = (account.syncState as { imap?: { folders?: Record<string, unknown> } } | null)
      ?.imap;
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
    return { ok: false, error: errorMessage(err) };
  }
}

/**
 * Persist the explicit folder allow-list for an account and kick an immediate
 * rescan. Zero folders clears the list back to NULL ("scan all non-excluded").
 * Owner-scoped; returns false if the account isn't found. The rescan enqueue is
 * best-effort — if the queue is down the 2-minute scheduler still picks it up.
 */
export async function setIncludedFolders(
  userId: string,
  accountId: string,
  folders: string[],
): Promise<boolean> {
  const clean = [...new Set(folders.map((f) => f.trim()).filter(Boolean))];
  const account = await getAccount(userId, accountId);
  if (!account) return false;

  await db
    .update(emailAccounts)
    .set({ imapIncludedFolders: clean.length > 0 ? clean : null, updatedAt: new Date() })
    .where(and(eq(emailAccounts.id, accountId), eq(emailAccounts.userId, userId)));

  try {
    const b = await boss();
    await b.send(SYNC_QUEUE, { accountId }, { singletonKey: `sync:${accountId}` });
  } catch (err) {
    console.error('[email] enqueue immediate sync failed', err);
  }
  return true;
}

/** Why an account cannot be the client sign-in sender's folder source. */
export type SentFolderRefusal = 'account-not-found' | 'folders-unreadable' | 'no-sent-folder';

/** How the sender folders are listed: the live IMAP server by default;
 *  tests stand in a folder list. */
export type FolderLister = (
  account: EmailAccount,
) => Promise<{ folders: string[]; sentFolders: string[] }>;

const imapFolderLister: FolderLister = async (account) => {
  if (
    account.provider !== 'imap' ||
    !account.imapHost ||
    !account.imapPort ||
    !account.imapConfigEnc
  ) {
    throw new Error('This account has no IMAP connection to list folders from.');
  }
  const probe = await probeImapConnection({
    host: account.imapHost,
    port: account.imapPort,
    secure: account.imapSecure,
    user: account.address,
    pass: unsealImapPassword(account),
  });
  return { folders: probe.folders, sentFolders: probe.sentFolders };
};

/**
 * The sent-mail folders of an account, as the client sign-in sender choice
 * would leave them out of sync (client logins C2b; audit B4, B19): the
 * `\Sent`-flagged folders when the server flags any, else the usual English
 * names. Refused when the folders cannot be listed or no sent folder is
 * found: then the choice cannot keep code mails out of the brain by folder,
 * and the admin must know before choosing. Owner-scoped. Writes nothing.
 */
export async function planSentFolders(
  userId: string,
  accountId: string,
  deps: { list?: FolderLister } = {},
): Promise<
  | { ok: true; account: EmailAccount; sentFolders: string[] }
  | { ok: false; reason: SentFolderRefusal; error: string }
> {
  const account = await getAccount(userId, accountId);
  if (!account) return { ok: false, reason: 'account-not-found', error: 'Account not found.' };
  let listed: { folders: string[]; sentFolders: string[] };
  try {
    listed = await (deps.list ?? imapFolderLister)(account);
  } catch (err) {
    return { ok: false, reason: 'folders-unreadable', error: errorMessage(err) };
  }
  const sentFolders = pickSentFolders(listed.folders, listed.sentFolders);
  if (sentFolders.length === 0) {
    return { ok: false, reason: 'no-sent-folder', error: 'No sent-mail folder was found.' };
  }
  return { ok: true, account, sentFolders };
}

/**
 * Leave an account's sent-mail folders out of mail sync (client logins C2b:
 * the sign-in sender's Sent folder must not bring live codes into the brain).
 * Adds each sent folder to the excluded list and remembers EXACTLY the ones
 * it added (client_signin_sender_folders), so {@link restoreSentFolders}
 * can put them back when the sender changes. The allow-list is never
 * touched: the sync already scans it minus the excluded folders, so an
 * allow-list of only sent folders now scans nothing (it never widens to
 * "every folder"). Refused (nothing written) as {@link planSentFolders}.
 * Owner-scoped. The code mails are also skipped by their Message-ID and
 * header anyway (client-code-mail.ts); this is the second guard.
 */
export async function excludeSentFolders(
  userId: string,
  accountId: string,
  deps: { list?: FolderLister } = {},
): Promise<
  | { ok: true; excluded: string[]; added: string[] }
  | { ok: false; reason: SentFolderRefusal; error: string }
> {
  const plan = await planSentFolders(userId, accountId, deps);
  if (!plan.ok) return plan;
  return db.transaction(async (tx) => {
    const [account] = await tx
      .select({ excluded: emailAccounts.imapExcludedFolders })
      .from(emailAccounts)
      .where(and(eq(emailAccounts.id, accountId), eq(emailAccounts.userId, userId)))
      .limit(1)
      .for('update');
    if (!account) {
      return { ok: false as const, reason: 'account-not-found' as const, error: 'Account not found.' };
    }
    const [held] = await tx
      .select({ folders: clientSigninSenderFolders.folders })
      .from(clientSigninSenderFolders)
      .where(eq(clientSigninSenderFolders.accountId, accountId))
      .limit(1);
    const added = plan.sentFolders.filter((f) => !account.excluded.includes(f));
    const keep = [...new Set([...(held?.folders ?? []), ...added])];
    if (added.length > 0) {
      await tx
        .update(emailAccounts)
        .set({ imapExcludedFolders: [...account.excluded, ...added], updatedAt: new Date() })
        .where(and(eq(emailAccounts.id, accountId), eq(emailAccounts.userId, userId)));
    }
    await tx
      .insert(clientSigninSenderFolders)
      .values({ accountId, folders: keep, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: clientSigninSenderFolders.accountId,
        set: { folders: keep, updatedAt: new Date() },
      });
    return { ok: true as const, excluded: plan.sentFolders, added };
  });
}

/**
 * Put back the sent-mail folders a sign-in sender choice left out of sync:
 * for every account of this owner that holds some (except `keepAccountId`,
 * the sender being chosen now), take exactly the folders the choice added
 * off the excluded list (a folder the admin had excluded before stays) and
 * forget them. Returns the folders restored per account. Owner-scoped.
 */
export async function restoreSentFolders(
  userId: string,
  keepAccountId: string | null = null,
): Promise<Array<{ accountId: string; restored: string[] }>> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        accountId: clientSigninSenderFolders.accountId,
        folders: clientSigninSenderFolders.folders,
        excluded: emailAccounts.imapExcludedFolders,
      })
      .from(clientSigninSenderFolders)
      .innerJoin(emailAccounts, eq(emailAccounts.id, clientSigninSenderFolders.accountId))
      .where(eq(emailAccounts.userId, userId))
      .for('update');
    const out: Array<{ accountId: string; restored: string[] }> = [];
    for (const row of rows) {
      if (row.accountId === keepAccountId) continue;
      const restored = row.excluded.filter((f) => row.folders.includes(f));
      await tx
        .update(emailAccounts)
        .set({
          imapExcludedFolders: row.excluded.filter((f) => !row.folders.includes(f)),
          updatedAt: new Date(),
        })
        .where(and(eq(emailAccounts.id, row.accountId), eq(emailAccounts.userId, userId)));
      await tx
        .delete(clientSigninSenderFolders)
        .where(eq(clientSigninSenderFolders.accountId, row.accountId));
      out.push({ accountId: row.accountId, restored });
    }
    return out;
  });
}

/** The folders a sign-in sender choice holds out of sync for `accountId`. */
export async function heldSentFolders(accountId: string): Promise<string[]> {
  const [row] = await db
    .select({ folders: clientSigninSenderFolders.folders })
    .from(clientSigninSenderFolders)
    .where(eq(clientSigninSenderFolders.accountId, accountId))
    .limit(1);
  return row?.folders ?? [];
}
