/**
 * The member API's wire shapes (member logins, Phase 1): what a MEMBER login's
 * client reads from /api/member/*. A member reads team-level items only (the
 * brain enforces it with row security) and chats with the team-level agent in
 * its own thread.
 */
import type { AccessLevel, MemberItemAuthor } from './access';
import type { MemberItemKind } from '../member-kinds';
import type { TreeKind } from '../tree';
export type { MemberItemFilter } from '../member-kinds';

/** GET /api/member/shell */
export type MemberShell = {
  role: 'member';
  loginId: string;
  displayName: string | null;
  email: string;
  avatar: { style: string; seed: string; parts: unknown } | null;
  avatarPhotoVersion: string | null;
  /** Append as `?at=` to /api/member/files/* and /api/member/draws/* srcs. */
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
  /** The kinds this login browses as a read-only folder tree (GET
   *  /api/{member,client}/tree/:kind). Absent from brains before folder
   *  sharing: the client keeps its flat lists there. */
  treeKinds?: TreeKind[];
};

export type MemberLibraryKind = MemberItemKind;

export type MemberLibraryRow = {
  id: string;
  type: MemberLibraryKind;
  title: string;
  icon: string | null;
  summary: string | null;
  /** A member's Library holds team and client items (client logins,
   *  decision 6): 'client' = a client login reads it too (the Client badge). */
  audience: 'team' | 'client';
  updatedAt: string;
  /** A member wrote it and an admin accepted it (the member-authored badge).
   *  Absent from brains before 0.232.285. */
  author?: MemberItemAuthor | null;
};

/** GET /api/member/library?kind=&q=&page= */
export type MemberLibraryPage = {
  items: MemberLibraryRow[];
  total: number;
  page: number;
  pageSize: number;
};

/** GET /api/member/library/:id -> { item } */
export type MemberLibraryItem =
  | (MemberLibraryRow & { type: 'page'; doc: unknown })
  | (MemberLibraryRow & { type: 'note'; content: string })
  | (MemberLibraryRow & { type: 'table'; table: unknown })
  | (MemberLibraryRow & { type: 'draw' })
  | (MemberLibraryRow & {
      type: 'file';
      filename: string;
      mimeType: string | null;
      sizeBytes: number | null;
    });

export type MemberChatMessage = {
  id: string;
  direction: 'inbound' | 'outbound';
  text: string;
  status: 'pending' | 'complete' | 'failed';
  failed: boolean;
  createdAt: string;
};

/** GET /api/member/chat. `agent` null = chat not open yet (no team-level agent). */
export type MemberChatThread = {
  agent: { slug: string; name: string } | null;
  messages: MemberChatMessage[];
};

// ── Personal spaces (member logins Phase 2) ──────────────────────────────

export type MemberSpaceSharing = 'private' | 'team';
/** A personal item's review state as the brain stores it. `taken` (brains
 *  from the take-over release, migration 0183): an admin took the submitted
 *  item into their own private space; only admin rows carry it. */
export type MemberReviewState = 'draft' | 'submitted' | 'returned' | 'accepted' | 'taken';

/** A row's state in a list: the stored state, or `with-admin` on the
 *  MEMBER's own list for an item an admin took over (title and kind only:
 *  opening it answers 409 `with-admin`). */
export type MemberSpaceItemState = MemberReviewState | 'with-admin';

/** One item of a personal space: GET /api/member/space[/team] rows. */
export type MemberSpaceItemRow = {
  id: string;
  type: MemberItemKind;
  title: string;
  icon: string | null;
  sharing: MemberSpaceSharing;
  reviewState: MemberSpaceItemState;
  submittedAt: string | null;
  returnedNote: string | null;
  /** The login that wrote it (team drafts show whose it is). */
  authorLoginId: string | null;
  /** Brains from the item-list alignment release on. */
  createdAt?: string;
  updatedAt: string;
};

/**
 * GET /api/member/space?kind=&q=&review=&page= (and /space/team). On the
 * member's own list, page 1 also carries the member's items an admin has
 * taken over (reviewState `with-admin`, before the own rows; `total` counts
 * them), unless `review=` names states without `with-admin`.
 */
export type MemberSpaceList = {
  items: MemberSpaceItemRow[];
  total: number;
  page: number;
  pageSize: number;
};

// ── An admin's private space and Take over (audit F07) ──────────────────

/** Who wrote an item an admin took over from the Review queue. */
export type AdminTakenFrom = {
  /** The member login; null once that login is deleted. */
  loginId: string | null;
  /** Display name, else the email's local part; "Removed member" once the
   *  login is deleted. */
  name: string;
  /** False when the member is deactivated, deleted or no longer a member:
   *  give-back is refused (409 `author-inactive`), accept or delete it. */
  canGiveBack: boolean;
  takenAt: string | null;
};

/** One row of GET /api/admin/space: a member row, plus who wrote it when
 *  the admin took it over (reviewState `taken`), else null. */
export type AdminSpaceItemRow = MemberSpaceItemRow & { takenFrom: AdminTakenFrom | null };

/** GET /api/admin/space?kind=&q=&review=&page= */
export type AdminSpaceList = {
  items: AdminSpaceItemRow[];
  total: number;
  page: number;
  pageSize: number;
};

/** GET /api/admin/space/:id (and the PATCH answer). */
export type AdminSpaceItem<TDoc = unknown, TTable = unknown> = {
  row: AdminSpaceItemRow;
  body: MemberSpaceItemBody<TDoc, TTable>;
};

/** An item that moved with a Take over or a Give back. */
export type MovedSpaceItem = { id: string; type: MemberItemKind; title: string };

/** POST /api/team-admin/submissions/:id/take-over -> 200 */
export type TakeOverResult = {
  /** The taken item: now in the acting admin's private space, same id. */
  id: string;
  /** It and its bundle, in bundle order. */
  moved: MovedSpaceItem[];
};

/** POST /api/admin/space/:id/give-back { note } -> 200 */
export type GiveBackResult = {
  id: string;
  /** Back in the member's space: the item `returned` with the note, the rest
   *  of what was taken with it as drafts. */
  returned: MovedSpaceItem[];
};

/** A space file's metadata; the bytes stream from the item's bytes route. */
export type MemberSpaceFile = {
  id: string;
  filename: string;
  extension: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string | null;
};

/**
 * An item's body. The page, drawing and table shapes are the brain's own
 * editor models (content-core); the contract leaves them to the client, which
 * narrows them with `TDoc` / `TTable`.
 */
export type MemberSpaceItemBody<TDoc = unknown, TTable = unknown> =
  | { type: 'page'; page: { doc: TDoc; draft: TDoc | null; draftRev?: number; title: string } }
  | { type: 'note'; note: { content: string; title: string } }
  /** Null for a teammate: their drawing shows from its saved SVG route. */
  | { type: 'draw'; draw: { scene: TDoc; draft: TDoc | null; draftRev?: number } | null }
  | { type: 'table'; table: TTable }
  | { type: 'file'; file: MemberSpaceFile };

/** GET /api/member/space/:id (and the team read): the row and its body. */
export type MemberSpaceItem<TDoc = unknown, TTable = unknown> = {
  row: MemberSpaceItemRow;
  body: MemberSpaceItemBody<TDoc, TTable>;
};

// ── Accepted items (member logins Phase 4, plan 6.2) ────────────────────

/** An item this member wrote and an admin accepted into the brain. */
export type MemberAcceptedRow = {
  id: string;
  type: MemberItemKind;
  title: string;
  icon: string | null;
  /** The level the admin chose: at team or lower it is in the Library too. */
  audience: AccessLevel;
  /** The share it takes from a folder holding it: in the Library at that
   *  level too, whatever `audience` says. Absent from brains before folder
   *  sharing. */
  inherited?: 'team' | 'client' | null;
  acceptedAt: string | null;
  updatedAt: string;
};

/** GET /api/member/accepted?kind=&page= (brains from 0.232.285) */
export type MemberAcceptedPage = {
  items: MemberAcceptedRow[];
  total: number;
  page: number;
  pageSize: number;
};

/** GET /api/member/accepted/:id -> { item }: the version ACCEPTED (the
 *  snapshot taken at Accept, brains from the take-over release; never the
 *  brain's current version), whatever its level. A drawing shows from
 *  /api/member/draws/:id/svg, a file's bytes from /api/member/files/:id.
 *  `changedByAdmin: true`: an admin changed the file (or a drawing with no
 *  saved picture) since, so its bytes are not served any more; the metadata
 *  is what was accepted. */
export type MemberAcceptedItem =
  | (MemberAcceptedRow & { type: 'page'; doc: unknown })
  | (MemberAcceptedRow & { type: 'note'; content: string })
  | (MemberAcceptedRow & { type: 'table'; table: unknown })
  | (MemberAcceptedRow & { type: 'draw'; changedByAdmin?: boolean })
  | (MemberAcceptedRow & {
      type: 'file';
      filename: string;
      mimeType: string | null;
      sizeBytes: number | null;
      changedByAdmin?: boolean;
    });

// ── One list of everything a member can see (item-list alignment) ───────

/** Where a row of the one list comes from; it picks the item view that
 *  opens it: `own` the member's editor, `team` a teammate's saved draft,
 *  `library` the brain item, `accepted` the version this member wrote and an
 *  admin accepted at a level above the Library's (admin or public),
 *  `client-request` a client's SUBMITTED item (client logins C5, decision
 *  5 B), read only from /api/member/client-requests/:id; its `space` row
 *  carries the review state, its `author` the client (role `client`). */
export type MemberItemSource = 'own' | 'team' | 'library' | 'accepted' | 'client-request';

/** The small state pill a row wears beside its actions. Brain items (the
 *  Library and accepted rows) wear none. */
export type MemberItemPill = 'private' | 'draft' | 'submitted' | 'returned' | 'with-admin';

/** One row of GET /api/member/items. */
export type MemberItemRow = {
  id: string;
  type: MemberItemKind;
  title: string;
  icon: string | null;
  summary: string | null;
  updatedAt: string;
  source: MemberItemSource;
  pill: MemberItemPill | null;
  /** The brain item's level (library and accepted rows); null on a draft. */
  audience: AccessLevel | null;
  /** A brain item a member wrote and an admin accepted: whose it is. */
  author: MemberItemAuthor | null;
  /** This member wrote it and an admin accepted it. */
  byMe: boolean;
  /** The personal-space row (own and team rows): sharing, review state, the
   *  returned note, for the item view and the detail header. */
  space: MemberSpaceItemRow | null;
};

/** GET /api/member/client-requests/:id (client logins C5, decision 5 B): a
 *  client's SUBMITTED item, read only, with its author (the client). File
 *  bytes: /api/member/client-requests/:id/bytes. */
export type MemberClientRequestItem<TDoc = unknown, TTable = unknown> = MemberSpaceItem<
  TDoc,
  TTable
> & { author: MemberItemAuthor };

/**
 * GET /api/member/items?kind=&q=&state=&page= (brains from the item-list
 * alignment release): the member's own items, teammates' shared drafts, the
 * Library and their accepted items above it, in ONE list, newest first.
 * `state` is a MemberItemFilter (default `all`). Absent on older brains: the
 * client then falls back to the four source lists.
 */
export type MemberItemsPage = {
  items: MemberItemRow[];
  total: number;
  page: number;
  pageSize: number;
};

/**
 * The calling admin's own private item as a row of a BRAIN list (item-list
 * alignment): /api/pages, /api/notes, /api/tables, /api/draws and the files
 * root and Recent lists, with `?state=all` or `?state=private`. The
 * `private` key marks it (brain rows never carry it) and holds the space
 * row the item view opens; the item itself is read and written through
 * /api/admin/space. Private items have no tags and no parent: a tag filter
 * or a sub-page level lists none.
 */
export type AdminPrivateListRow = {
  id: string;
  type: MemberItemKind;
  title: string;
  icon: string | null;
  createdAt: string;
  updatedAt: string;
  private: AdminSpaceItemRow;
};
