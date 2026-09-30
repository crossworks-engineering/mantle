/**
 * The Access control's wire shapes (`/api/access/nodes/:id`). One level
 * system: admin > team > client > public. A caller sees what is at or below
 * its level. The level is the truth and the item's share link follows it:
 * none at admin or team (members read team items with their own logins) or
 * client (signed-in clients, client logins C1), an open link at public. See
 * docs/access-levels.md.
 */
import type { ShareMode } from './rows';

/** Highest first: the order the control shows them in. */
export const ACCESS_LEVELS = ['admin', 'team', 'client', 'public'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

/** One item as the Access control lists it (the item itself or its closure). */
export type AccessItemView = {
  id: string;
  type: string;
  title: string;
  audience: AccessLevel;
};

/** The item's link. `path` is server-relative (`/s/<token>`). */
export type AccessLinkView = {
  id: string;
  token: string;
  path: string;
  mode: ShareMode;
  /** DEPRECATED (folder phase 7): a page link no longer shares sub-pages
   *  (pages do not nest); always false. Kept for older clients. */
  cascade: boolean;
};

/** GET /api/access/nodes/:id */
/** Who wrote a brain item, when a member wrote it and an admin accepted it
 *  (member logins Phase 4): the member-authored badge. `name` is the login's
 *  display name ("A member" without one, "A client" for a client without
 *  one, "Removed member" once deleted). `role` (0.232.333 on) names the
 *  author's role: show "Client", never "A member", for a client (client
 *  logins audit B26); null once the login is deleted. */
export type MemberItemAuthor = {
  name: string;
  acceptedAt: string | null;
  role?: 'member' | 'client' | null;
};

export type AccessNodeView = {
  item: AccessItemView;
  /** What the item's link or embeds need, each at its own level. For a page,
   *  drawing or note: what it embeds (images, files, drawings, child pages,
   *  transitively), which goes down with it when it is lowered (0.232.314
   *  on; before that it only did on "Lower them too"). For a folder: its
   *  contents, which keep their own levels. */
  closure: AccessItemView[];
  share: AccessLinkView | null;
  /** DEPRECATED (folder phase 7): pages do not nest, so always 0. Kept for
   *  older clients, which showed "Include sub-pages" above 0. */
  childCount: number;
  /** Only workspace kinds go below admin (tasks, events, … are admin only). */
  canLower: boolean;
  /** Whether the item can carry a link (a folder only under `files`). */
  canLink: boolean;
  /** True for a page, drawing or note: lowering it lowers its embeds with it
   *  (embedding means sharing), so the control says what will be shared
   *  instead of offering "Lower them too". False for a folder, whose
   *  contents keep their levels. Absent from brains before 0.232.314, which
   *  lower embeds only on request. */
  embedsFollow?: boolean;
  /** Set when a member wrote it and an admin accepted it into the brain (the
   *  member-authored badge). Absent from brains before 0.232.285. */
  author?: MemberItemAuthor | null;
  /** Levels at which this brain makes a NEW open link (client logins C1:
   *  ['public']). Absent on brains before C1: the client then uses the old
   *  copy (Client = open link). */
  openLinkLevels?: AccessLevel[];
  /** Old live links above this item (see ClientOldLinkAbove); only for an
   *  item at client. */
  oldLinksAbove?: ClientOldLinkAbove[];
  /** The shared folder it takes its share from (folder sharing); null when
   *  none. Absent from brains before folder sharing. */
  sharedVia?: AccessSharedVia | null;
  /** What it is read through by embeds (migration 0208); null when nothing
   *  reaches it. Absent from brains before 0208. */
  readThrough?: AccessReadThrough | null;
};

/** An item is read through the items that embed it (migration 0208): a
 *  shared note makes its image readable wherever the image lives. The item
 *  is read at least at `level`, whatever its own level says, so the control
 *  offers nothing above it: take the embed out, or move the embedder out of
 *  its shared folder, to hide it. */
export type AccessReadThrough = {
  level: 'team' | 'client';
  /** The nearest items that embed it and carry a share, most open first
   *  (at most five). */
  via: Array<{
    id: string;
    title: string;
    /** The node type ('note', 'page', 'draw', ...). */
    type: string;
    level: 'team' | 'client';
    /** 'folder': shared by its own folder; 'embed': itself read through
     *  another embed. */
    through: 'folder' | 'embed';
  }>;
};

/** The nearest shared folder holding an item (folder sharing, phase 4). The
 *  item is read at least at `level`, whatever its own level says, so the
 *  control offers nothing above it: moving it out of the folder hides it. */
export type AccessSharedVia = {
  folderId: string;
  /** Folder names from the kind's top level down to the shared folder. */
  trail: string[];
  level: 'team' | 'client';
};

/** One item that went down with the item that embeds it. */
export type AccessLoweredView = {
  id: string;
  type: string;
  title: string;
  from: AccessLevel;
  to: AccessLevel;
};

/** PATCH /api/access/nodes/:id { audience, withClosure?, raiseClosure? }.
 *  `withClosure` only matters for a folder (its contents); a page's,
 *  drawing's or note's embeds always follow it down. */
export type AccessNodeUpdate = {
  item: AccessItemView;
  /** Everything lowered with it, at its new level: the embeds that followed
   *  it and, with `withClosure`, a folder's contents. */
  lowered: AccessItemView[];
  /** The embeds that followed it down, with the level each left and took.
   *  Absent from brains before 0.232.314. */
  alsoLowered?: AccessLoweredView[];
  /** Closure items still above the new level: an embed that can never go
   *  below admin, or a folder's contents when not `withClosure`. */
  stillAbove: AccessItemView[];
  /** Closure items raised with it (only when `raiseClosure`). Absent from
   *  brains before 0.232.264. */
  raised?: AccessItemView[];
  /** Closure items still below the new level (when not `raiseClosure`).
   *  Absent from brains before 0.232.264. */
  stillBelow?: AccessItemView[];
  share: AccessLinkView | null;
};

// ── "What clients see" (client logins C1) ────────────────────────────────────

/** A live open link on something ABOVE a client-level item (a folder that
 *  holds it, or a client page that embeds it): made when client meant
 *  "anyone with the link", still live until old client links retire.
 *  Anyone with that link can open this item. */
export type ClientOldLinkAbove = {
  shareId: string;
  /** The folder or page that carries the link. */
  nodeId: string;
  title: string;
  type: string;
  via: 'folder' | 'page';
};

/** A brain item a client-level item names but a client may not read: a
 *  mention chip, a link or an embed pointing at a team or admin item (or at
 *  something that is not the brain's). Its title reaches the client page as
 *  a label unless the client view hides it. */
export type ClientReportRef = {
  id: string;
  /** Null when the id names nothing the brain holds: gone, or an item that
   *  is not the brain's (a personal item), whose title is never shown. */
  type: string | null;
  title: string | null;
  /** The item's level; null when it is not a brain item (a personal item,
   *  or gone). */
  audience: AccessLevel | null;
};

/** One item at client level, as the report lists it. */
export type ClientReportItem = {
  id: string;
  type: string;
  title: string;
  updatedAt: string;
  /** Its live open link, made when client meant "anyone with the link":
   *  still live until the old client links are retired. Null: none. */
  link: {
    id: string;
    createdAt: string;
    viewCount: number;
    lastViewedAt: string | null;
    expiresAt: string | null;
  } | null;
  /** Addresses a page was emailed to with the page tool (invite hints). */
  emailedTo: string[];
  /** What it names that a client may not read (see ClientReportRef). */
  refsAbove: ClientReportRef[];
  /** Live old links on a folder that holds it or a client page that embeds
   *  it: anyone with one of those links can open this item. Absent from
   *  brains before the audit fixes. */
  oldLinksAbove?: ClientOldLinkAbove[];
};

/** The newest acknowledgement of the report. */
export type ClientReportAck = {
  ackedAt: string;
  /** The admin who acknowledged it (null: that login is gone). */
  ackedBy: { id: string; name: string } | null;
  /** How many client-level items the admin saw. */
  itemCount: number;
};

/** GET /api/access/client-report: every item at client level, what each
 *  carries, and whether an admin has acknowledged the list. Adding a client
 *  login stays disabled until `acknowledged` (client logins C2). */
export type ClientReport = {
  items: ClientReportItem[];
  /** All client-level items (the list stops at 2000). */
  total: number;
  acknowledgement: ClientReportAck | null;
  /** An admin acknowledged the report and nothing has gone to client since. */
  acknowledged: boolean;
  /** Client-level items the newest acknowledgement did not include. */
  newSinceAck: string[];
  /** sha256 hex of every current client-level item id (sorted, joined by
   *  ','), the WHOLE set, not the 2000 shown. Send it back to acknowledge.
   *  Absent from brains before the audit fixes. */
  fingerprint?: string;
};

/** POST /api/access/client-report/ack { fingerprint } (preferred) or
 *  { itemIds } (old) -> the acknowledgement. With a fingerprint the server
 *  recomputes it: equal records every current client-level item, different
 *  answers 409 { error: 'conflict', reason: 'report-changed', message } and
 *  the client reloads the report. `itemIds`: the client-level items the
 *  admin saw on the report. */
export type ClientReportAckResponse = { acknowledgement: ClientReportAck; acknowledged: boolean };

/** GET /api/shares/all -> { shares: SharedLinkRow[] }: every live link,
 *  newest first. */
export type SharedLinkRow = {
  id: string;
  /** Server-relative: `/s/<token>`. */
  path: string;
  nodeId: string;
  nodeType: string;
  title: string;
  icon: string | null;
  mode: ShareMode;
  cascade: boolean;
  createdAt: string;
  viewCount: number;
  lastViewedAt: string | null;
  /** The item's level (client logins C1): `client` marks an old link, from
   *  when client meant an open link. Absent from brains before C1. */
  level?: AccessLevel;
};

/** An old client link the brain retired (client logins C3, migration 0192):
 *  it answers "Sign in as a client" now. No token: the link is dead. */
export type RetiredClientLinkRow = {
  id: string;
  nodeId: string;
  nodeType: string;
  title: string;
  icon: string | null;
  /** The item's level now (client, unless an admin changed it since). */
  level: AccessLevel;
  createdAt: string;
  retiredAt: string | null;
  viewCount: number;
  lastViewedAt: string | null;
};
