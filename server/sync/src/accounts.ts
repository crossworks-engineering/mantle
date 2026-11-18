/**
 * What a person or an admin's agent can do to the Sync service's accounts
 * (Sync service plan M3): the one set of actions behind both the screens
 * (ui.ts) and the brain's admin tools (admin.ts, the sync_* tools). A
 * refusal the person can act on is an AccountError, its text shown as it is.
 */
import { randomUUID } from 'node:crypto';
import { errorMessage } from '@mantle/std';
import { BrainError, type Brain } from './brain';
import { clearFeed } from './feeds';
import { probe } from './imap';
import { runError } from './mail';
import { appView, discoverDrives, MAIL_SEND_SCOPE } from './microsoft';
import { probeSmtp } from './send';
import type { Lane, Scheduler } from './scheduler';
import {
  DEFAULT_EXCLUDED_FOLDERS,
  type DriveSelection,
  type Feed,
  type MailAccount,
  type MsAccount,
  type MsDrive,
  type State,
} from './state';

export type AccountDeps = { brain: Brain; state: State; scheduler: Scheduler; lane: Lane };

export class AccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountError';
  }
}

export const DAYS_MAX = 3650;

/** The brain's mailbox row for an address (made or found). A 409: the
 *  address is linked the other way (IMAP or Outlook), said as it is. */
async function mailboxRow(
  deps: AccountDeps,
  body: Record<string, unknown>,
): Promise<{ id: string }> {
  try {
    return await deps.brain.post<{ id: string }>('/api/sidecar/mail/accounts', body);
  } catch (err) {
    if (err instanceof BrainError && err.status === 409) throw new AccountError(err.message);
    throw err;
  }
}
const SELECTIONS_MAX = 500;

function portOf(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

export type MailboxInput = {
  address: string;
  displayName?: string | null;
  /** Empty or absent: keep the stored one (an edit). */
  password?: string;
  imapHost: string;
  imapPort: number | string;
  imapSecure: boolean;
  /** Empty or absent: this mailbox does not send. */
  smtpHost?: string | null;
  smtpPort?: number | string | null;
  smtpSecure?: boolean;
  firstScanDays?: number | string | null;
  enabled: boolean;
};

/** Add (id null) or edit a mailbox: checked by an IMAP login, and an SMTP
 *  login when it sends, before it is saved. Its first sync starts. */
export async function saveMailbox(
  deps: AccountDeps,
  id: string | null,
  input: MailboxInput,
): Promise<MailAccount> {
  const existing = id ? await deps.state.account(id) : null;
  if (id && !existing) throw new AccountError('No such mailbox.');
  const address = existing?.address ?? input.address.trim().toLowerCase();
  const imapHost = input.imapHost.trim();
  const smtpHost = (input.smtpHost ?? '').trim();
  const imapPort = portOf(input.imapPort);
  const smtpPort = smtpHost ? portOf(input.smtpPort) : null;
  const days = Number(input.firstScanDays || 365);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address) || address.length > 320)
    throw new AccountError('Enter an email address.');
  if (!imapHost || !imapPort) throw new AccountError('Enter the IMAP server and port.');
  if (smtpHost && !smtpPort) throw new AccountError('Enter the SMTP port.');
  if (!Number.isInteger(days) || days < 1 || days > DAYS_MAX)
    throw new AccountError(`The first scan reaches back 1 to ${DAYS_MAX} days.`);
  const secret = input.password || existing?.password || '';
  if (!secret) throw new AccountError('Enter the app password.');

  const imap = { host: imapHost, port: imapPort, secure: input.imapSecure };
  const smtp =
    smtpHost && smtpPort ? { host: smtpHost, port: smtpPort, secure: !!input.smtpSecure } : null;
  try {
    await probe({ imap, address, password: secret });
  } catch (err) {
    throw new AccountError(`IMAP login failed: ${runError(err, { address, password: secret })}`);
  }
  if (smtp) {
    try {
      await probeSmtp(smtp, address, secret);
    } catch (err) {
      throw new AccountError(`SMTP login failed: ${runError(err, { address, password: secret })}`);
    }
  }
  const displayName = (input.displayName ?? '').trim() || null;
  const { id: mailboxId } = await mailboxRow(deps, {
    address,
    displayName,
    enabled: input.enabled,
  });
  const account: MailAccount = {
    id: mailboxId,
    address,
    displayName,
    imap,
    smtp,
    password: secret,
    firstScanDays: days,
    excludedFolders: existing?.excludedFolders ?? DEFAULT_EXCLUDED_FOLDERS,
    includedFolders: existing?.includedFolders ?? null,
    enabled: input.enabled,
  };
  await deps.state.putAccount(account);
  if (account.enabled) deps.scheduler.runNow(account.id);
  return account;
}

/** Add (id null) or edit a calendar feed. Its first sync starts. */
export async function saveFeed(
  deps: AccountDeps,
  id: string | null,
  input: { name: string; url?: string | null; enabled: boolean },
): Promise<Feed> {
  const existing = id ? await deps.state.feed(id) : null;
  if (id && !existing) throw new AccountError('No such feed.');
  const name = input.name.trim().slice(0, 200);
  if (!name) throw new AccountError('Enter a name.');
  const url = (input.url ?? '').trim() || existing?.url || '';
  if (!/^(https?|webcal):\/\//i.test(url) || url.length > 4000)
    throw new AccountError('Enter an https or webcal address.');
  const feed: Feed = { id: existing?.id ?? randomUUID(), name, url, enabled: input.enabled };
  await deps.state.putFeed(feed);
  if (feed.enabled) deps.scheduler.runNow(feed.id);
  return feed;
}

/** How long a removal waits for the lane before it answers. */
const REMOVE_WAIT_MS = 20_000;

/** True when `job` finished within REMOVE_WAIT_MS (its error thrown), false
 *  when it is still queued behind a long sync: it then finishes on its own. */
async function settlesSoon(job: Promise<unknown>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = new Promise<false>((r) => (timer = setTimeout(() => r(false), REMOVE_WAIT_MS)));
  // A queued removal that fails later is logged, never unhandled.
  job.catch((err: unknown) => console.warn(`[sync] a removal failed: ${errorMessage(err)}`));
  try {
    return await Promise.race([job.then(() => true as const), wait]);
  } finally {
    clearTimeout(timer);
  }
}

export type Removed = { name: string; done: boolean; what: 'mailbox' | 'feed' | 'microsoft' };

/** Remove a mailbox, a feed or a Microsoft account by its id. Each waits for
 *  a run of it under way (the lane), so nothing that run stores comes back.
 *  Stored mail and synced files stay; a feed's events go with it. */
export async function removeAccount(deps: AccountDeps, id: string): Promise<Removed> {
  const mailbox = await deps.state.account(id);
  if (mailbox) {
    const done = await settlesSoon(
      deps.lane.exclusive(async () => {
        await deps.brain
          .del(`/api/sidecar/mail/accounts/${id}?provider=imap`)
          .catch((err: unknown) => {
            // A mailbox row the brain no longer has: the state still goes.
            if ((err as { status?: number }).status !== 404) throw err;
          });
        await deps.state.deleteAccount(id);
      }),
    );
    return { name: mailbox.address, done, what: 'mailbox' };
  }
  const feed = await deps.state.feed(id);
  if (feed) {
    const done = await settlesSoon(
      deps.lane.exclusive(async () => {
        await clearFeed(deps.brain, feed);
        await deps.state.deleteFeed(id);
      }),
    );
    return { name: feed.name, done, what: 'feed' };
  }
  const ms = await deps.state.msAccount(id);
  if (ms) {
    const done = await settlesSoon(deps.lane.exclusive(() => disconnect(deps, ms)));
    return { name: ms.upn, done, what: 'microsoft' };
  }
  throw new AccountError('No such account.');
}

/** A Microsoft account disconnected: its drives' file maps and state go,
 *  its mailbox row is switched off, its tokens deleted. Every synced file
 *  and stored mail stays. */
async function disconnect(deps: AccountDeps, account: MsAccount): Promise<void> {
  for (const d of await deps.state.msDrives()) {
    if (d.accountId !== account.id) continue;
    await deps.brain.post('/api/sidecar/files/forget', { source: d.id });
    await deps.state.deleteMsDrive(d.id);
  }
  if (account.mailboxId) {
    await deps.brain
      .del(`/api/sidecar/mail/accounts/${account.mailboxId}?provider=microsoft`)
      .catch((err: unknown) => {
        if ((err as { status?: number }).status !== 404) throw err;
      });
  }
  await deps.state.deleteMsAccount(account.id);
}

/** Switch a Microsoft account's Outlook mail on or off. On: its mailbox
 *  row (no credential) is made or switched on, and a first run starts. Off:
 *  the row is switched off; its stored mail stays. */
export async function setOutlookMail(
  deps: AccountDeps,
  accountId: string,
  on: boolean,
): Promise<MsAccount> {
  const account = await deps.state.msAccount(accountId);
  if (!account) throw new AccountError('No such Microsoft account.');
  if (on) {
    const { id: mailboxId } = await mailboxRow(deps, {
      address: account.upn.toLowerCase(),
      displayName: account.displayName,
      enabled: true,
      provider: 'microsoft',
      branchPath: `${account.branchPath}.mail`,
    });
    const next = { ...account, mail: true, mailboxId };
    await deps.state.putMsAccount(next);
    deps.scheduler.runNow(mailboxId);
    return next;
  }
  if (account.mailboxId) {
    await deps.brain
      .del(`/api/sidecar/mail/accounts/${account.mailboxId}?provider=microsoft`)
      .catch((err: unknown) => {
        if ((err as { status?: number }).status !== 404) throw err;
      });
  }
  const next = { ...account, mail: false };
  await deps.state.putMsAccount(next);
  return next;
}

/** Switch a drive on or off, or choose what in it syncs (none chosen: the
 *  whole drive). A file that falls outside the new choice leaves the brain
 *  at the next run. */
export async function setDrive(
  deps: AccountDeps,
  driveId: string,
  input: { enabled?: boolean; selections?: DriveSelection[] },
): Promise<MsDrive> {
  const drive = await deps.state.msDrive(driveId);
  if (!drive) throw new AccountError('No such drive.');
  let selections = drive.selections;
  if (input.selections) {
    if (input.selections.length > SELECTIONS_MAX)
      throw new AccountError(`Choose at most ${SELECTIONS_MAX} folders and files.`);
    selections = input.selections.map((s) => {
      if (!s.path.startsWith('/') || s.path.length > 2000 || !s.itemId || s.itemId.length > 400)
        throw new AccountError('A chosen folder or file has no path from the drive root.');
      return {
        itemId: s.itemId,
        path: s.path,
        isFolder: !!s.isFolder,
        ...(s.name ? { name: s.name.slice(0, 400) } : {}),
      };
    });
  }
  const next: MsDrive = { ...drive, enabled: input.enabled ?? drive.enabled, selections };
  await deps.state.putMsDrive(next);
  if (next.enabled) deps.scheduler.runNow(next.id);
  return next;
}

/** Look for the account's drives again (a new SharePoint site followed). */
export async function refreshDrives(deps: AccountDeps, accountId: string): Promise<MsDrive[]> {
  if (!(await deps.state.msAccount(accountId)))
    throw new AccountError('No such Microsoft account.');
  return discoverDrives(deps.state, accountId);
}

/** Sync one mailbox, feed, drive or Outlook inbox now (by its id). */
export async function runNow(deps: AccountDeps, id: string): Promise<string> {
  const mailbox = await deps.state.account(id);
  if (mailbox) {
    deps.scheduler.runNow(id);
    return mailbox.address;
  }
  const feed = await deps.state.feed(id);
  if (feed) {
    deps.scheduler.runNow(id);
    return feed.name;
  }
  const drive = await deps.state.msDrive(id);
  if (drive) {
    deps.scheduler.runNow(id);
    return drive.name;
  }
  const ms = await deps.state.msAccount(id);
  if (ms?.mail && ms.mailboxId) {
    deps.scheduler.runNow(ms.mailboxId);
    return ms.upn;
  }
  throw new AccountError('No such account, or nothing in it syncs.');
}

/** Everything the Sync service holds, for a screen or a tool: no password,
 *  token or feed address. */
export async function overview(deps: AccountDeps) {
  const [mailboxes, feeds, msAccounts, drives, app] = await Promise.all([
    deps.state.accounts(),
    deps.state.feeds(),
    deps.state.msAccounts(),
    deps.state.msDrives(),
    deps.state.msApp(),
  ]);
  const statusOf = (id: string) => deps.state.status(id);
  return {
    mailboxes: await Promise.all(
      mailboxes.map(async (a) => ({
        id: a.id,
        address: a.address,
        enabled: a.enabled,
        sends: !!a.smtp,
        imapHost: a.imap.host,
        smtpHost: a.smtp?.host ?? null,
        status: await statusOf(a.id),
      })),
    ),
    feeds: await Promise.all(
      feeds.map(async (f) => ({
        id: f.id,
        name: f.name,
        enabled: f.enabled,
        status: await statusOf(f.id),
      })),
    ),
    microsoft: {
      app: appView(app),
      accounts: await Promise.all(
        msAccounts.map(async (a) => ({
          id: a.id,
          upn: a.upn,
          displayName: a.displayName,
          mail: a.mail,
          sends: a.mail && a.scopes.includes(MAIL_SEND_SCOPE),
          lastError: a.lastError ?? null,
          mailStatus: a.mailboxId ? await statusOf(a.mailboxId) : null,
          drives: await Promise.all(
            drives
              .filter((d) => d.accountId === a.id)
              .map(async (d) => ({
                id: d.id,
                name: d.name,
                siteName: d.siteName,
                driveType: d.driveType,
                enabled: d.enabled,
                selections: d.selections,
                status: await statusOf(d.id),
              })),
          ),
        })),
      ),
    },
  };
}
