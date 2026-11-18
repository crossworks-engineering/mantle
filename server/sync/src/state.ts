/**
 * The sidecar's state, kept in the brain (service_state, sealed there with
 * the master key; /api/sidecar/state). Nothing is kept on disk here.
 *
 *   account:<mailbox id>  a linked IMAP/SMTP mailbox, its password included
 *   cursor:<mailbox id>   the last UID seen per folder
 *   feed:<feed id>        a calendar feed (its URL can carry a secret)
 *   status:<id>           the last run of a mailbox, a feed or a drive
 *   msapp                 the Microsoft (Azure) app: client id, secret, tenant
 *   msaccount:<id>        a connected Microsoft account and its tokens
 *   msdrive:<id>          a OneDrive or SharePoint library of one, its selections
 *   mscursor:<id>         an account's Outlook mail watermark
 *   msoauth:<state>       a sign-in under way (10 minutes, used once)
 */
import type { Brain } from './brain';

export type HostPort = { host: string; port: number; secure: boolean };

export type MailAccount = {
  id: string;
  address: string;
  displayName?: string | null;
  imap: HostPort;
  /** Null: this mailbox does not send. */
  smtp: HostPort | null;
  /** The app password, for IMAP and SMTP both. */
  password: string;
  /** How far back the first scan of a folder reaches. */
  firstScanDays: number;
  excludedFolders: string[];
  /** Non-empty: scan only these folders. */
  includedFolders: string[] | null;
  enabled: boolean;
};

export type MailCursor = { folders: Record<string, { uidvalidity: number; lastUid: number }> };

export type Feed = { id: string; name: string; url: string; enabled: boolean };

export type RunStatus = {
  at: string;
  ok: boolean;
  /** A short fixed text when it failed. */
  error?: string;
  /** Mail: messages stored. Feed: events in the feed. */
  count?: number;
};

/** The Microsoft (Azure) app this box signs in with (Sync service plan M3). */
export type MsApp = {
  clientId: string;
  clientSecret: string;
  /** `common`, `organizations`, or a tenant id. */
  tenant: string;
  /** The exact redirect URI registered on the app. */
  redirectUri: string;
};

/** A connected Microsoft account. */
export type MsAccount = {
  id: string;
  /** The sign-in name (user principal name, else the mail address). */
  upn: string;
  displayName: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  /** When the access token ends (ms since the epoch). */
  expiresAt: number | null;
  scopes: string[];
  /** Where its files and mail land (ltree), e.g. `microsoft.jo_ab12`. */
  branchPath: string;
  /** Outlook mail syncs (the mail switch). */
  mail: boolean;
  /** The brain's mailbox row its mail lands under, once mail was on. */
  mailboxId: string | null;
  /** The last token refresh's failure, cleared by the next success. */
  lastError?: string | null;
};

/** A folder or file chosen to sync; none chosen: the whole drive. */
export type DriveSelection = { itemId: string; path: string; isFolder: boolean; name?: string };

/** A OneDrive or a SharePoint library of a connected account. */
export type MsDrive = {
  id: string;
  accountId: string;
  /** Microsoft's drive id. */
  driveId: string;
  /** `personal`, `business` or `documentLibrary`. */
  driveType: string;
  name: string;
  siteName: string | null;
  webUrl: string | null;
  /** The ltree label its files land under, below the account's branch. */
  branchLabel: string;
  enabled: boolean;
  selections: DriveSelection[];
};

export type MsCursor = { since: string | null };

export type MsOAuth = { verifier: string; at: number };

export const DEFAULT_EXCLUDED_FOLDERS = [
  'INBOX.Trash',
  'INBOX.Junk',
  'INBOX.spam',
  'INBOX.Drafts',
  'INBOX.Blocked',
  'Trash',
  'Junk',
  'Spam',
  'Drafts',
];

export type State = ReturnType<typeof createState>;

export function createState(brain: Brain) {
  const path = (key: string) => `/api/sidecar/state/${encodeURIComponent(key)}`;
  async function get<T>(key: string): Promise<T | null> {
    try {
      const r = await brain.get<{ value: T }>(path(key));
      return r.value;
    } catch (err) {
      if ((err as { status?: number }).status === 404) return null;
      throw err;
    }
  }
  async function list<T>(prefix: string): Promise<T[]> {
    const r = await brain.get<{ values: { key: string; value: T }[] }>(
      `/api/sidecar/state?prefix=${encodeURIComponent(prefix)}`,
    );
    return r.values.map((v) => v.value);
  }
  const put = (key: string, value: unknown) => brain.put(path(key), { value });
  const del = (key: string) => brain.del(path(key));
  return {
    accounts: () => list<MailAccount>('account:'),
    account: (id: string) => get<MailAccount>(`account:${id}`),
    putAccount: (a: MailAccount) => put(`account:${a.id}`, a),
    deleteAccount: async (id: string) => {
      await del(`account:${id}`);
      await del(`cursor:${id}`);
      await del(`status:${id}`);
    },
    cursor: async (id: string) => (await get<MailCursor>(`cursor:${id}`)) ?? { folders: {} },
    putCursor: (id: string, c: MailCursor) => put(`cursor:${id}`, c),
    feeds: () => list<Feed>('feed:'),
    feed: (id: string) => get<Feed>(`feed:${id}`),
    putFeed: (f: Feed) => put(`feed:${f.id}`, f),
    deleteFeed: async (id: string) => {
      await del(`feed:${id}`);
      await del(`status:${id}`);
    },
    status: (id: string) => get<RunStatus>(`status:${id}`),
    putStatus: (id: string, s: RunStatus) => put(`status:${id}`, s),
    msApp: () => get<MsApp>('msapp'),
    putMsApp: (a: MsApp) => put('msapp', a),
    msAccounts: () => list<MsAccount>('msaccount:'),
    msAccount: (id: string) => get<MsAccount>(`msaccount:${id}`),
    putMsAccount: (a: MsAccount) => put(`msaccount:${a.id}`, a),
    deleteMsAccount: async (id: string) => {
      await del(`msaccount:${id}`);
      await del(`mscursor:${id}`);
      await del(`status:${id}`);
    },
    msDrives: () => list<MsDrive>('msdrive:'),
    msDrive: (id: string) => get<MsDrive>(`msdrive:${id}`),
    putMsDrive: (d: MsDrive) => put(`msdrive:${d.id}`, d),
    deleteMsDrive: async (id: string) => {
      await del(`msdrive:${id}`);
      await del(`status:${id}`);
    },
    msCursor: async (id: string) => (await get<MsCursor>(`mscursor:${id}`)) ?? { since: null },
    putMsCursor: (id: string, c: MsCursor) => put(`mscursor:${id}`, c),
    oauth: (st: string) => get<MsOAuth>(`msoauth:${st}`),
    /** Every sign-in under way: its state and value. */
    oauthAll: async () => {
      const r = await brain.get<{ values: { key: string; value: MsOAuth }[] }>(
        `/api/sidecar/state?prefix=${encodeURIComponent('msoauth:')}`,
      );
      return r.values.map((v) => ({ key: v.key.slice('msoauth:'.length), value: v.value }));
    },
    putOAuth: (st: string, o: MsOAuth) => put(`msoauth:${st}`, o),
    deleteOAuth: (st: string) => del(`msoauth:${st}`),
  };
}
