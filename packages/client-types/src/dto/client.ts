/**
 * The client wire shapes left after the client portal went. The portal
 * (/api/client/*), admin-issued sign-in links and Team admin > Clients were
 * removed: a client login uses the one (app) shell (`Shell`, GET /api/shell).
 * What stays: the email sign-in codes (any client login signs in with one),
 * the admin's choice of the code sender, the label a redacted reference
 * carries, and the row shapes the member files still name.
 */
import type { ClientItemKind } from '../member-kinds';
import type { MemberItemPill, MemberSpaceItemRow } from './member';

/** The label a client sees instead of a reference it may not read. */
export const CLIENT_PRIVATE_LABEL = 'Private item';

// ── Email sign-in codes (C2b) ───────────────────────────────────────────────

/** GET /api/auth/client-code: whether this brain sends sign-in codes (an
 *  admin chose a sign-in sender). Says nothing about any email. */
export type ClientCodeAvailability = { enabled: boolean };

/** POST /api/auth/client-code { email } -> always 200 { ok: true } and a
 *  fresh request cookie, whatever the email: the answer never tells whether
 *  it is a client. When it is an active client login, a code is mailed
 *  shortly after (8 digits, 10 minutes, one use, 5 tries, this browser). */
export type ClientCodeRequested = { ok: true };

/** POST /api/auth/client-code/verify { email, code } -> 200 { ok: true } and
 *  the session cookie (30 days), or one uniform 401 for every failure (a
 *  forwarded code without this browser's request cookie among them); 429
 *  when rate limited. */
export type ClientCodeSignIn = { ok: true };

/** An email account the brain can send sign-in codes from. */
export type ClientSigninSenderCandidate = { id: string; address: string };

/** GET /api/team-admin/clients/signin-sender, and the answer to PUT
 *  { accountId: string | null }. Codes are off while `sender` is null. When
 *  a sender is chosen, its sent-mail folders are left out of mail sync
 *  (`sentFoldersExcluded`), and every code mail carries a marker the sync
 *  skips anywhere, so a live code never enters the brain. `capReached`: the
 *  brain sent `dailyCap` codes in the last 24 hours; requests still answer
 *  200, but nothing is sent until the window moves on. */
export type ClientSigninSender = {
  sender: ClientSigninSenderCandidate | null;
  candidates: ClientSigninSenderCandidate[];
  sentFoldersExcluded: string[];
  dailyCap: number;
  sentLast24h: number;
  capReached: boolean;
  /** Codes actually handed to the mail server in the last 24 h (sentLast24h counted failed ones too; it now equals this). */
  deliveredLast24h?: number;
  /** Sends that failed in the last 24 h, and the newest failure. */
  failedLast24h?: number;
  lastFailure?: { at: string; reason: string } | null;
  /** False when no email worker serves the code queue on this box: codes are then OFF whatever the sender. */
  emailWorker?: boolean;
  /** Requests that were skipped because a cap was hit in the last 24 h (per email, per address or brain-wide). */
  capSkipsLast24h?: number;
};

/** GET /api/team-admin/clients/signin-sender/preview?accountId=<id>: what
 *  choosing that account as the sender would do, before the admin confirms.
 *  Choosing None (or another sender) later RESTORES the folders the choice
 *  left out (the server remembers exactly which it added). */
export type ClientSigninSenderPreview = {
  /** The folders that choosing this sender will leave out of mail sync. Empty + canUse false = refused. */
  sentFolders: string[];
  canUse: boolean;
  reason?: 'no-sent-folder' | 'folders-unreadable' | 'account-cannot-send';
};

/** Why an admin's sender choice was refused (the 4xx `reason`). */
export type ClientSenderRefusedReason =
  'account-not-found' | 'account-cannot-send' | 'no-sent-folder' | 'folders-unreadable';

// ── The client's own items, My requests (client logins C5) ─────────────────

/**
 * Where a row of My requests comes from: `own` an item in the client's own
 * space (GET /api/client/space/:id; a draft, submitted, returned, or with a
 * reviewer who took it over), `accepted` the version the client wrote and an
 * admin accepted (GET /api/client/accepted/:id).
 */
export type ClientItemSource = 'own' | 'accepted';

/** One row of the client's My requests (GET /api/client/items, 410 now;
 *  the member files still build it). No level, no staff name. */
export type ClientItemRow = {
  id: string;
  type: ClientItemKind;
  title: string;
  icon: string | null;
  updatedAt: string;
  source: ClientItemSource;
  /** `private` a draft, `submitted`, `returned`, `with-admin`; null on an
   *  accepted row. Never `draft` (a client never shares with the team). */
  pill: MemberItemPill | null;
  /** The space row of an own item (review state, the returned note). */
  space: MemberSpaceItemRow | null;
  acceptedAt: string | null;
};

/** GET /api/client/accepted/:id (410 now) -> { item }: the version
 *  the client wrote and an admin accepted (the snapshot taken at Accept, never the brain's
 *  current version). A file's bytes: /api/client/files/:id while the brain
 *  file still holds the bytes accepted (`changedByAdmin` otherwise). */
export type ClientAcceptedItem =
  | (ClientAcceptedBase & { type: 'page'; doc: unknown; folderId?: string | null })
  | (ClientAcceptedBase & { type: 'note'; content: string })
  | (ClientAcceptedBase & {
      type: 'file';
      filename: string;
      mimeType: string | null;
      sizeBytes: number | null;
      changedByAdmin?: boolean;
    });

export type ClientAcceptedBase = {
  id: string;
  title: string;
  icon: string | null;
  acceptedAt: string | null;
  updatedAt: string;
};
