/**
 * The item tree: one navigation for every workspace kind (docs/folder-tree.md).
 *
 * A kind's items live under the kind's root (`files`, `notes`, ...). Folders
 * are `branch` rows under that root and nest at most TREE_MAX_DEPTH deep; an
 * item's location is its folder's path, and an item at the root is unsorted.
 * Items are never parents. Every reader (admin, member, client) browses the
 * same tree, pruned by the brain to what that reader may see.
 *
 * Pure (no runtime deps) so the brain and every client share the kinds, the
 * limits and the wire shapes. A runtime constant module, so it is the
 * `@mantle/client-types/tree` subpath.
 */
import type { AccessLevel } from './dto/access';
import type { AppTint } from './app-nav';

/** The kinds the tree serves, in navigation order. */
export const TREE_KINDS = [
  'files',
  'notes',
  'pages',
  'draw',
  'tables',
  'formulas',
  'apps',
  'tasks',
  'events',
  'contacts',
  'secrets',
] as const;
export type TreeKind = (typeof TREE_KINDS)[number];

export function isTreeKind(v: unknown): v is TreeKind {
  return typeof v === 'string' && (TREE_KINDS as readonly string[]).includes(v);
}

/** Folders nest at most this deep below a kind's root: folder › subfolder ›
 *  sub-subfolder. Items sit in any of them. */
export const TREE_MAX_DEPTH = 3;
/** Items per folder page; the client asks for the next page as it scrolls. */
export const TREE_PAGE_SIZE = 50;
export const TREE_PAGE_MAX = 100;
export const TREE_FOLDER_NAME_MAX = 60;
export const TREE_SEARCH_MAX = 200;

/** The orders a folder's items can be listed in. Folders always keep their
 *  own manual order (rank, then name). */
export const TREE_SORTS = ['name', 'updated', 'start', 'due'] as const;
export type TreeSort = (typeof TREE_SORTS)[number];

export function isTreeSort(v: unknown): v is TreeSort {
  return typeof v === 'string' && (TREE_SORTS as readonly string[]).includes(v);
}

/** Who a shared folder shares its contents with. Public is never a folder
 *  share: an item goes public through its own link. */
export const TREE_SHARE_LEVELS = ['team', 'client'] as const;
export type TreeShareLevel = (typeof TREE_SHARE_LEVELS)[number];

/** Everything that differs between kinds, in one place. The brain adds its
 *  own hooks (the files disk mirror); a client reads the rest. */
export type TreeKindSpec = {
  kind: TreeKind;
  /** The ltree root label of the kind (the `*_ROOT_LABEL` constants). */
  root: string;
  /** `nodes.type` of the kind's items. */
  nodeType: string;
  /** Whether a folder of this kind may be shared below admin. The kinds that
   *  are admin-only forever (the type ceiling) never are. */
  shareable: boolean;
  /** The item orders offered, the first being the default. */
  sorts: readonly TreeSort[];
};

export const TREE_KIND_SPECS: Readonly<Record<TreeKind, TreeKindSpec>> = {
  files: {
    kind: 'files',
    root: 'files',
    nodeType: 'file',
    shareable: true,
    sorts: ['name', 'updated'],
  },
  notes: {
    kind: 'notes',
    root: 'notes',
    nodeType: 'note',
    shareable: true,
    sorts: ['updated', 'name'],
  },
  pages: {
    kind: 'pages',
    root: 'pages',
    nodeType: 'page',
    shareable: true,
    sorts: ['updated', 'name'],
  },
  draw: {
    kind: 'draw',
    root: 'draw',
    nodeType: 'draw',
    shareable: true,
    sorts: ['updated', 'name'],
  },
  tables: {
    kind: 'tables',
    root: 'tables',
    nodeType: 'table',
    shareable: true,
    sorts: ['updated', 'name'],
  },
  formulas: {
    kind: 'formulas',
    root: 'formulas',
    nodeType: 'formula',
    shareable: true,
    sorts: ['name', 'updated'],
  },
  apps: {
    kind: 'apps',
    root: 'apps',
    nodeType: 'app',
    shareable: true,
    sorts: ['name', 'updated'],
  },
  tasks: {
    kind: 'tasks',
    root: 'tasks',
    nodeType: 'task',
    shareable: false,
    sorts: ['due', 'updated', 'name'],
  },
  events: {
    kind: 'events',
    root: 'events',
    nodeType: 'event',
    shareable: false,
    sorts: ['start', 'name'],
  },
  contacts: {
    kind: 'contacts',
    root: 'contacts',
    nodeType: 'contact',
    shareable: false,
    sorts: ['name', 'updated'],
  },
  secrets: {
    kind: 'secrets',
    root: 'secrets',
    nodeType: 'secret',
    shareable: false,
    sorts: ['name', 'updated'],
  },
};

/** One folder as the tree shows it. Counts are what THIS reader can see. */
export type TreeFolder = {
  id: string;
  /** The folder's ltree path: its identity in agent tools and on disk. */
  path: string;
  name: string;
  /** An emoji or `lucide:<name>` (the app-nav icon vocabulary); null = the
   *  default folder glyph. */
  icon: string | null;
  color: AppTint | null;
  /** 1..TREE_MAX_DEPTH below the kind's root. */
  depth: number;
  /** The parent folder; null at the top level. */
  parentId: string | null;
  /** The folder's own share (it shares everything below it); null = none. */
  share: TreeShareLevel | null;
  /** Made by Mantle (Auto-filed): the name is locked and it cannot be shared. */
  system: boolean;
  folderCount: number;
  itemCount: number;
};

/** An item's review state, when it has one (the one-list pill vocabulary). */
export type TreeItemState = 'private' | 'draft' | 'submitted' | 'returned' | 'with-admin';

/** One item as the tree shows it: a title and what the status slot needs.
 *  Summaries, descriptions and tags live in the item's own view. */
export type TreeItem = {
  id: string;
  title: string;
  /** The item's own icon when it has one (emoji or lucide key). */
  icon: string | null;
  color: AppTint | null;
  /** A short kind-specific token for the status slot: a file's extension, a
   *  secret's kind, an event's start. Null when the kind has none. */
  subtype: string | null;
  /** Who can read it: its own level, or its folder's share when that is more
   *  open. */
  level: AccessLevel;
  state: TreeItemState | null;
  updatedAt: string;
};

export type TreeCrumb = { id: string; name: string };

/** GET /api/tree/:kind?folder= — one folder's direct subfolders (all, in
 *  order) and one page of its items. `folder` null is the kind's root. */
export type TreeFolderPage = {
  kind: TreeKind;
  folder: TreeFolder | null;
  /** Top-down, excluding `folder` itself. */
  crumbs: TreeCrumb[];
  folders: TreeFolder[];
  items: TreeItem[];
  sort: TreeSort;
  /** Pass back as `cursor` for the next page of items; null at the end. */
  nextCursor: string | null;
};

/** GET /api/tree/:kind/search?q= — matching folders first, then items, each
 *  with the crumbs of where it lives. */
export type TreeSearchResult = {
  kind: TreeKind;
  folders: Array<TreeFolder & { crumbs: TreeCrumb[] }>;
  items: Array<TreeItem & { crumbs: TreeCrumb[] }>;
  nextCursor: string | null;
};

/** The flat views beside the tree: this login's pins, recent and most used
 *  items of a kind. */
export const TREE_MARK_VIEWS = ['pinned', 'recent', 'used'] as const;
export type TreeMarkView = (typeof TREE_MARK_VIEWS)[number];
export const TREE_PINS_MAX = 12;

export type TreeMarkList = {
  kind: TreeKind;
  view: TreeMarkView;
  items: Array<TreeItem & { crumbs: TreeCrumb[] }>;
};

/** A write that would change who can see something is refused with this
 *  (409) until it is repeated with `confirm: true`. */
export type TreeVisibilityChange = {
  id: string;
  title: string;
  from: AccessLevel;
  to: AccessLevel;
};
export type TreeVisibilityRefusal = { error: 'visibility'; changes: TreeVisibilityChange[] };
