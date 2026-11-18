/**
 * The sidecar's state, kept in the brain (service_state, sealed there with
 * the master key; /api/sidecar/state). Nothing is kept on disk here.
 *
 *   account:<mailbox id>  a linked IMAP/SMTP mailbox, its password included
 *   cursor:<mailbox id>   the last UID seen per folder
 *   feed:<feed id>        a calendar feed (its URL can carry a secret)
 *   status:<id>           the last run of a mailbox or a feed
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
  };
}
