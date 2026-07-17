/**
 * Account data layer — owner-scoped reads/writes for email accounts.
 *
 * Lifted out of `apps/web` (the settings/accounts pages + IMAP form action) so
 * the same logic is reachable both in-process (SSR) and over HTTP (`/api/email`)
 * and by any non-Next consumer. Every function takes the owner `userId` and
 * scopes by it — a stolen account UUID can never touch another owner's row.
 */
import { createHash } from 'node:crypto';
import PgBoss from 'pg-boss';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { db, emailAccounts, syncRuns, type EmailAccount, type SyncRun } from '@mantle/db';
import { seal } from '@mantle/crypto';
import { probeImapConnection, unsealImapPassword } from './providers/imap';
import { probeSmtpConnection } from './send';

/** Immediate-rescan queue — must match the email-sync worker's queue name. */
const SYNC_QUEUE = 'mantle.email.sync';

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
  const raw = err instanceof Error ? err.message : String(err);
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
      /** Folders the sync has actually touched (per the cursor). */
      scanned: string[];
    }
  | { ok: false; error: string };

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
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
