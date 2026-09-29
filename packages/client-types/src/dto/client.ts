/**
 * The client API's wire shapes (client logins, Phase C2): what a CLIENT
 * login's app reads from /api/client/*, and what an admin reads and writes
 * about client logins in Team admin > Clients. A client reads items at
 * client level only (the brain enforces it with row security). Client DTOs
 * never carry a staff name or an author: clients see the brand name.
 */
import type { ClientItemKind, MemberItemKind } from '../member-kinds';
import type { MemberItemPill, MemberSpaceItemRow } from './member';
import type { NodeComment } from './rows';

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
  'chat-closed' | 'idempotency-key-reused' | 'rate-limited' | 'daily_cap' | 'token_budget';

/** GET /api/team-admin/clients/usage: each client login's chat use today
 *  (UTC) against the caps every client login has (the member caps). */
export type ClientChatUsage = {
  limits: { dailyTurns: number; dailyTokens: number };
  rows: { loginId: string; turnsToday: number; tokensToday: number }[];
};

// ── The client's own items, My requests (client logins C5) ─────────────────

/**
 * Where a row of My requests comes from: `own` an item in the client's own
 * space (GET /api/client/space/:id; a draft, submitted, returned, or with a
 * reviewer who took it over), `accepted` the version the client wrote and an
 * admin accepted (GET /api/client/accepted/:id).
 */
export type ClientItemSource = 'own' | 'accepted';

/** One row of GET /api/client/items. No level, no staff name. */
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

/** GET /api/client/items?kind=&q=&state=&page=: the client's own items and
 *  their accepted items in ONE list, newest first. `state` is a
 *  ClientItemFilter (default `all`). */
export type ClientItemsPage = {
  items: ClientItemRow[];
  total: number;
  page: number;
  pageSize: number;
};

/**
 * The client's own space (/api/client/space*, /api/client/space-files): the
 * member space routes' shapes (MemberSpaceItem, MemberSpaceItemRow,
 * MemberSpaceList) for kinds page, note and file only. No share route: a
 * client's item is private until submitted, and a submitted item goes to the
 * reviewers (and members read it as a client request). Refusals (the 409
 * `reason`): the member ones, plus `quota` for the client caps: 20 MB a file,
 * 200 MB a client, 50 MB uploaded a day, 500 items, 10 submissions a day, 50
 * waiting for review, and one total for all client spaces of the brain. The
 * 200 MB and the total count page and note text too (C5 audit). A page
 * document over 500 KB serialized (draft or Save version), or a note over
 * 50,000 characters, is a 400 `too-large`. The comment caps:
 * ClientCommentRefusedReason. Any JSON body over the route's ceiling (8 MB)
 * is a 413 `body-too-large`.
 */
export type ClientSpaceRefusedReason =
  | 'not-found'
  | 'frozen'
  | 'not-draft'
  | 'not-submitted'
  | 'unsaved-draft'
  | 'quota'
  | 'embed'
  | 'not-shared'
  | 'too-large'
  | 'invalid'
  | 'with-admin';

/** GET /api/client/accepted/:id -> { item }: the version the client wrote
 *  and an admin accepted (the snapshot taken at Accept, never the brain's
 *  current version). A file's bytes: /api/client/files/:id while the brain
 *  file still holds the bytes accepted (`changedByAdmin` otherwise). */
export type ClientAcceptedItem =
  | (ClientAcceptedBase & { type: 'page'; doc: unknown })
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

// ── Comments (client logins C5, decision 8) ─────────────────────────────────

/**
 * GET /api/client/shared/:id/comments (POST { body } -> 201 { comment },
 * DELETE /comments/:commentId for the client's own): the thread on an item
 * shared with clients. The team, admins and every client login read and
 * write it; each comment shows its author's display name (clients are
 * approved users). Only on an item at client level: any other id is a 404.
 *
 * GET /api/client/space/:id/comments (POST, DELETE own) on the client's own
 * item: the review talk with the reviewers, open while it is submitted. A
 * reviewer's comment shows the brand name, never a staff name.
 */
export type ClientCommentThread = {
  comments: NodeComment[];
  /**
   * Older comments exist (client logins C5 audit): a thread answers its
   * NEWEST 100 comments, oldest first; `?before=<createdAt of the oldest
   * shown>` answers the 100 before them. The same paging and `hasMore` on
   * GET /api/member/library/:id/comments, /api/member/space/:id/comments,
   * /api/team-admin/submissions/:id/comments and /api/nodes/:id/comments.
   * Absent on an older brain (the whole thread).
   */
  hasMore?: boolean;
};

/**
 * Why a comment was refused (the 4xx `reason`, client logins C5 audit): 429
 * `comment-cap` (a client login writes at most 100 comments a day across
 * every thread, the review talk and client threads; deleting one does not
 * give it back), 409 `thread-full` (one thread holds at most 1000
 * comments).
 */
export type ClientCommentRefusedReason = 'comment-cap' | 'thread-full';

// ── Team admin > Clients: storage and client threads (C5 audit) ────────────

/**
 * GET /api/team-admin/clients/storage (admin only): what the client spaces
 * hold against the client limits. A client space counts files, page
 * documents (saved, draft and plain text) and note text, as stored.
 * `limits.totalBytes` is the brain-wide total for ALL client spaces (5 GB
 * unless the box sets MANTLE_CLIENT_SPACES_TOTAL_BYTES). A `former` row is a
 * deleted client's space: it still counts until its 30-day purge, and its
 * `loginId` is the space's id (the login row is gone).
 */
export type ClientStorageUsage = {
  limits: {
    fileMaxBytes: number;
    perClientBytes: number;
    dailyUploadBytes: number;
    itemLimit: number;
    totalBytes: number;
    submitsPerDay: number;
    openSubmissions: number;
  };
  totalUsedBytes: number;
  rows: {
    loginId: string;
    name: string;
    usedBytes: number;
    uploadedTodayBytes: number;
    items: number;
    openSubmissions: number;
    former: boolean;
  }[];
  /** Quota refusals in the last 7 days, newest first, at most 50. */
  refusals: { at: string; loginId: string | null; reason: string }[];
};

/**
 * GET /api/team-admin/clients/comments?days=7 (admin only, 1 to 90 days):
 * the client-level items whose client thread had a comment by a CLIENT in
 * the window, newest first, at most 100. `clientComments` counts the
 * clients' comments in the window; `lastClientName` is the newest one's
 * author. Open the thread on /api/nodes/:id/comments.
 */
export type ClientThreadActivity = {
  rows: {
    nodeId: string;
    title: string;
    type: string;
    lastCommentAt: string;
    clientComments: number;
    lastClientName: string;
  }[];
};

/** DELETE /api/team-admin/clients/:id/comments (admin only): every comment
 *  that client login wrote (client threads and review talk) is removed. */
export type ClientCommentsDeleted = { deleted: number };
