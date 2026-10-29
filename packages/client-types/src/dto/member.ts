/**
 * The member API's wire shapes: what a MEMBER login's client reads from
 * /api/member/*. A member reads what its workspaces hold (the brain
 * enforces it with row security) and chats with the Team workspace's
 * assistant in its own thread.
 */
import type { MemberItemAuthor } from './access';
import type { MemberItemKind } from '../member-kinds';
export type { MemberItemFilter } from '../member-kinds';

export type MemberLibraryKind = MemberItemKind;

export type MemberLibraryRow = {
  id: string;
  type: MemberLibraryKind;
  title: string;
  icon: string | null;
  summary: string | null;
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
  | (MemberLibraryRow & { type: 'page'; doc: unknown; folderId?: string | null })
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

/** GET /api/member/chat. `agent` null = chat not open yet (the Team workspace
 *  has no assistant). */
export type MemberChatThread = {
  agent: { slug: string; name: string } | null;
  messages: MemberChatMessage[];
};

// ── Personal spaces ──────────────────────────────────────────────────────

export type MemberSpaceSharing = 'private' | 'team';
/** A personal item's review state as the brain stores it. `taken` (brains
 *  from the take-over release, migration 0183): an admin took the submitted
 *  item into their own private space; only admin rows carry it. */
export type MemberReviewState = 'draft' | 'submitted' | 'returned' | 'accepted' | 'taken';

/** A row's state in a list: the stored state, or `with-admin` on the
 *  MEMBER's own list for an item an admin took over (title and kind only:
 *  opening it answers 409 `with-admin`). */
export type MemberSpaceItemState = MemberReviewState | 'with-admin';

/** One item of a personal space: GET /api/member/space rows. */
export type MemberSpaceItemRow = {
  id: string;
  type: MemberItemKind;
  title: string;
  icon: string | null;
  sharing: MemberSpaceSharing;
  reviewState: MemberSpaceItemState;
  submittedAt: string | null;
  returnedNote: string | null;
  /** The login that wrote it. */
  authorLoginId: string | null;
  /** Brains from the item-list alignment release on. */
  createdAt?: string;
  updatedAt: string;
};

/**
 * GET /api/member/space?kind=&q=&review=&page=. On the
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

// ── An admin's private space and Take over ──────────────────────────────

/** Who wrote an item an admin took over from the Review queue (Take over
 *  and the queue are gone; an item taken over earlier still names its
 *  author). */
export type AdminTakenFrom = {
  /** The member login; null once that login is deleted. */
  loginId: string | null;
  /** Display name, else the email's local part; "Removed member" once the
   *  login is deleted. */
  name: string;
  /** Always false: Give back was removed. */
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
  | {
      type: 'page';
      page: {
        doc: TDoc;
        draft: TDoc | null;
        draftRev?: number;
        title: string;
        /** The folder the page sits in (folder phase 7): the member's own
         *  folder or a brain folder, null at the top level. It is what a
         *  Folder index block set to `here` lists, through the reader's own
         *  tree route. Absent from a brain before the pages tree. */
        folderId?: string | null;
      };
    }
  | { type: 'note'; note: { content: string; title: string } }
  /** Null when only the saved SVG route shows the drawing. */
  | { type: 'draw'; draw: { scene: TDoc; draft: TDoc | null; draftRev?: number } | null }
  | { type: 'table'; table: TTable }
  | { type: 'file'; file: MemberSpaceFile };

/** GET /api/member/space/:id: the row and its body. */
export type MemberSpaceItem<TDoc = unknown, TTable = unknown> = {
  row: MemberSpaceItemRow;
  body: MemberSpaceItemBody<TDoc, TTable>;
};

// ── Accepted items ──────────────────────────────────────────────────────

/** An item this member wrote and an admin accepted into the brain. No
 *  level: whether the member's Library holds it too is
 *  its row in GET /api/member/items (`source` 'library'). */
export type MemberAcceptedRow = {
  id: string;
  type: MemberItemKind;
  title: string;
  icon: string | null;
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
 *  brain's current version), whoever reads it now. A drawing shows from
 *  /api/member/draws/:id/svg, a file's bytes from /api/member/files/:id.
 *  `changedByAdmin: true`: an admin changed the file (or a drawing with no
 *  saved picture) since, so its bytes are not served any more; the metadata
 *  is what was accepted. */
export type MemberAcceptedItem =
  | (MemberAcceptedRow & { type: 'page'; doc: unknown; folderId?: string | null })
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
 *  opens it: `own` the member's editor, `library` the brain item, `accepted`
 *  the version this member wrote and an admin accepted, which the member's
 *  Library does not hold. (`team` and `client-request` rows went with
 *  review.) */
export type MemberItemSource = 'own' | 'library' | 'accepted';

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
  /** A brain item a member wrote and an admin accepted: whose it is. */
  author: MemberItemAuthor | null;
  /** This member wrote it and an admin accepted it. */
  byMe: boolean;
  /** The personal-space row (own rows): sharing, review state, the
   *  returned note, for the item view and the detail header. */
  space: MemberSpaceItemRow | null;
};

/**
 * GET /api/member/items?kind=&q=&state=&page= (brains from the item-list
 * alignment release): the member's own items, the Library and their accepted
 * items above it, in ONE list, newest first.
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
