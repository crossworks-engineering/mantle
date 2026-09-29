/**
 * The client API's wire shapes (client logins, Phase C2): what a CLIENT
 * login's app reads from /api/client/*, and what an admin reads and writes
 * about client logins in Team admin > Clients. A client reads items at
 * client level only (the brain enforces it with row security). Client DTOs
 * never carry a staff name or an author: clients see the brand name.
 */
import type { MemberItemKind } from '../member-kinds';

/** GET /api/client/shell: who is signed in and the brain's brand. */
export type ClientShell = {
  role: 'client';
  loginId: string;
  displayName: string | null;
  email: string;
  /** Append as `?at=` to /api/client/files/* and /api/client/draws/* srcs. */
  assetToken: string;
  siteName: string | null;
  colorTheme: string | null;
  fontLogo: string | null;
  fontTitle: string | null;
  fontUi: string | null;
  fontProse: string | null;
  fontSize: string | null;
  fontLogoSize: string | null;
  fontTitleSize: string | null;
  fontProseSize: string | null;
  logoVersion: string | null;
  logoDarkVersion: string | null;
};

/** One item in "Shared with you": an item at client level. */
export type ClientSharedRow = {
  id: string;
  type: MemberItemKind;
  title: string;
  icon: string | null;
  /** Never sent since 0.232.333 (it was built from the unredacted text); do
   *  not show it. Optional only so older clients still compile. */
  summary?: string | null;
  updatedAt: string;
};

/** GET /api/client/shared?kind=&q=&page= : newest first. */
export type ClientSharedPage = {
  items: ClientSharedRow[];
  total: number;
  page: number;
  pageSize: number;
};

/** GET /api/client/shared/:id -> { item }. A page's doc and a note's text
 *  come with every reference to something a client may not read replaced:
 *  a mention chip or a link names "Private item" and points nowhere, an
 *  embed of such an item is left out. */
export type ClientSharedItem =
  | (ClientSharedRow & { type: 'page'; doc: unknown })
  | (ClientSharedRow & { type: 'note'; content: string })
  | (ClientSharedRow & { type: 'table'; table: ClientSharedTable })
  | (ClientSharedRow & { type: 'draw' })
  | (ClientSharedRow & {
      type: 'file';
      filename: string;
      mimeType: string | null;
      sizeBytes: number | null;
    });

/** One column of a client table: what the grid draws a header and a cell
 *  with. No formula, no reference source, no options. */
export type ClientSharedTableColumn = { id: string; name: string; type: string };

/** One committed row of a client table. A cell that names an item the
 *  client may not read (`/n/<id>`, `page:`, `media:`, `draw:`, `mention:`)
 *  arrives as "Private item". */
export type ClientSharedTableRow = {
  id: string;
  cells: Record<string, string | number | boolean | string[] | null>;
};

/** A client table (GET /api/client/shared/:id, type table): the committed
 *  grid of one tab and nothing else about the table (no description, tags,
 *  summary, visibility, level, app link or draft). The shape the member
 *  reader draws (`data`, `docClipped`, `tabs`, `tabId`), so one viewer reads
 *  both. `data` is a leading window when `docClipped`; `rowCount` is the
 *  tab's true total. */
export type ClientSharedTable = {
  data: {
    columns: ClientSharedTableColumn[];
    rows: ClientSharedTableRow[];
    /** Footer totals the owner set, by column id. */
    aggregates?: Record<string, string>;
  };
  docClipped?: boolean;
  /** The workbook's tabs in order (absent for a one-grid table). */
  tabs?: { id: string; name: string; rows: number; columns: number }[];
  /** Which tab `data` holds. */
  tabId?: string | null;
  rowCount?: number;
};

/** The label a client sees instead of a reference it may not read. */
export const CLIENT_PRIVATE_LABEL = 'Private item';

// ── Admin side: Team admin > Clients ────────────────────────────────────────

/** A sign-in link an admin issued (the code itself is shown once, at issue). */
export type ClientSigninLinkRow = {
  id: string;
  createdAt: string;
  expiresAt: string;
};

/** One client login, as Team admin > Clients lists it. */
export type ClientLoginRow = {
  id: string;
  email: string;
  displayName: string | null;
  contactId: string | null;
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  /** The open (unused, unexpired, unrevoked) sign-in link, if any. */
  openLink: ClientSigninLinkRow | null;
  /** When a sign-in link of this login was last used. */
  lastLinkUsedAt: string | null;
};

/** GET /api/team-admin/clients. `reportAcknowledged`: an admin has checked
 *  "What clients see" and nothing went to client since; until then Add
 *  client and Issue sign-in link are refused (409 `report-not-acknowledged`). */
export type ClientLoginList = {
  clients: ClientLoginRow[];
  reportAcknowledged: boolean;
};

/** POST /api/team-admin/clients { email, displayName?, contactId? }
 *  -> { client }. The login has no password: it signs in with a link. */
export type ClientLoginCreated = { client: ClientLoginRow };

/** POST /api/team-admin/clients/:id/signin-link -> the link, ONCE. `path` is
 *  the client-app path to hand the client (the code is its only secret);
 *  72 hours, one use. Any older open link of the login is revoked. Since
 *  0.232.333 the code rides in the fragment (`/client-signin#code=...`), so
 *  it never reaches a server log; links issued before carry `?code=`. */
export type ClientSigninLinkCreated = {
  link: ClientSigninLinkRow;
  code: string;
  path: string;
};

/** Why an admin's client action was refused (the 4xx `reason`). */
export type ClientAdminRefusedReason =
  | 'report-not-acknowledged'
  | 'email-has-login'
  | 'contact-not-found'
  | 'contact-has-login'
  | 'no-email'
  | 'not-a-client'
  /** A contact-linked client's email must be one of the contact's addresses
   *  (the mail gates know the client by its contact; audit B26). */
  | 'email-not-on-contact';

/** POST /api/auth/client-link { code, email } -> 200 { ok: true } and the
 *  session cookie (30 days), or one uniform 401 for every failure. */
export type ClientLinkSignIn = { ok: true };

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

// ── Client chat (client logins C4) ───────────────────────────────────────

/** One message of a client's own chat thread. */
export type ClientChatMessage = {
  id: string;
  direction: 'inbound' | 'outbound';
  text: string;
  status: 'pending' | 'complete' | 'failed';
  failed: boolean;
  createdAt: string;
};

/** GET /api/client/chat[?before=ISO]: the client's own thread with the
 *  client-responder, newest page first (50 a page). `agent` null = the chat
 *  is not open (no enabled client-level client-responder): the dock says so
 *  and offers no input. Poll it (every few seconds while a reply is pending):
 *  there is no live stream for clients. */
export type ClientChatThread = {
  agent: { name: string } | null;
  messages: ClientChatMessage[];
};

/** POST /api/client/chat { text } -> 202: the turn is queued; the reply
 *  lands in the thread. A retry with the same Idempotency-Key is the same
 *  turn. */
export type ClientChatQueued = { turnId: string };

/** Why a client chat send was refused (the 4xx `reason`): 409 `chat-closed`
 *  (no client-level agent), 409 `idempotency-key-reused`, 429 `rate-limited`
 *  (6 a minute), 429 `daily_cap` or `token_budget` (the member caps, per
 *  client login per UTC day). */
export type ClientChatRefusedReason =
  | 'chat-closed'
  | 'idempotency-key-reused'
  | 'rate-limited'
  | 'daily_cap'
  | 'token_budget';

/** GET /api/team-admin/clients/usage: each client login's chat use today
 *  (UTC) against the caps every client login has (the member caps). */
export type ClientChatUsage = {
  limits: { dailyTurns: number; dailyTokens: number };
  rows: { loginId: string; turnsToday: number; tokensToday: number }[];
};
