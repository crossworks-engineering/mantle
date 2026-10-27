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
import type { GrantWorkspaceRef, ListWorkspace } from './dto/grants';
import type { TaskStatus } from './dto/rows';
import type { ElsewhereCount, HitWorkspaceField } from './dto/workspace-hits';
import type { AppTint } from './app-nav';
import {
  ITEM_KINDS,
  ITEM_KIND_NAMES,
  treeKindsBy,
  type KindTreeSpec,
  type RegistryTreeKind,
} from './kinds';

/** The kinds the tree serves, in navigation order: derived from the kind
 *  registry (./kinds, each kind's `tree.order`). A jackdaw contract: the
 *  order never changes (Recall, appended last, kept every earlier index). */
export const TREE_KINDS = treeKindsBy('order') as readonly RegistryTreeKind[];
export type TreeKind = RegistryTreeKind;

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
 *  own manual order (rank, then name). `custom` is the order people set by
 *  dragging (`data.tree_rank`, one for everyone): a folder that has one lists by
 *  it, then by name; one that has none lists in the kind's first other sort,
 *  so `custom` changes nothing until someone orders the folder. */
export const TREE_SORTS = ['name', 'updated', 'start', 'due', 'custom'] as const;
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
  /** The item orders offered, the first being the default: `custom` first
   *  for every kind, then the registry's own (the first of those is what an
   *  unordered folder lists in). */
  sorts: readonly TreeSort[];
};

/** Derived from the kind registry (./kinds): one spec per tree kind, keyed
 *  in navigation order. */
export const TREE_KIND_SPECS: Readonly<Record<TreeKind, TreeKindSpec>> = Object.fromEntries(
  ITEM_KIND_NAMES.flatMap((nodeType) => {
    const tree: KindTreeSpec | null = ITEM_KINDS[nodeType].tree;
    return tree ? [{ tree, nodeType }] : [];
  })
    .sort((a, b) => a.tree.order - b.tree.order)
    .map(({ tree, nodeType }): [string, TreeKindSpec] => [
      tree.kind,
      {
        kind: tree.kind as TreeKind,
        root: tree.root,
        nodeType,
        shareable: tree.shareable,
        sorts: ['custom', ...tree.sorts],
      },
    ]),
) as Record<TreeKind, TreeKindSpec>;

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
  /** DEPRECATED (W5b2): folder shares are frozen and grants decide who
   *  reads (`workspaces`). The brain's tree no longer sends it; a member's
   *  own folder still sends null. */
  share?: TreeShareLevel | null;
  /** DEPRECATED (W5b2): no longer sent by the brain's tree. */
  inherited?: TreeShareLevel | null;
  /** Made by Mantle (Auto-filed): the name is locked and it cannot be shared. */
  system: boolean;
  folderCount: number;
  itemCount: number;
  /** Asked with `?ws=<id>` (task f26a516e): the items in the folder that
   *  the caller reads in its other workspaces and `ws` does not read. They
   *  are not in `itemCount`; a client may still open the folder to say
   *  where they are (TreeFolderPage `elsewhere`). Absent without `ws`, and
   *  from a brain before it. */
  itemsElsewhere?: number;
  /** The workspaces that read the folder (ListChips): filled by the owner's
   *  tree routes; empty in the member tree until W5c. */
  workspaces: ListWorkspace[];
  /** A live open public link exists. */
  hasLink: boolean;
  /** A member's tree only: the member's own private folder (folder plan
   *  phase 5). Only they see it; they may rename, move and delete it. */
  own?: boolean;
};

/** An item's review state, when it has one (the one-list pill vocabulary). */
export type TreeItemState = 'private' | 'draft' | 'submitted' | 'returned' | 'with-admin';

/** Kind-specific facts a row draws: a task's done box and due date, an
 *  event's start. Only the kinds that have them send them. */
export type TreeItemMeta = {
  /** A task marked done. */
  done?: boolean;
  /** A done task: the status a reopen restores, when the brain knows it.
   *  Absent otherwise (a reopen then lands on 'open'). */
  reopensTo?: TaskStatus;
  /** A task's due instant (ISO), when it has one. */
  due?: string | null;
  /** An event's start (ISO). */
  start?: string | null;
};

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
  /** DEPRECATED (W5b2): the tier levels are frozen and grants decide who
   *  reads (`workspaces`, `hasLink`). The brain's tree no longer sends it. */
  level?: AccessLevel;
  /** DEPRECATED (W5b2): no longer sent. */
  inherited?: TreeShareLevel | null;
  /** DEPRECATED (W5b2): no longer sent. */
  embedded?: TreeShareLevel | null;
  state: TreeItemState | null;
  updatedAt: string;
  meta?: TreeItemMeta;
  /** The workspaces that read the item (ListChips): filled by the owner's
   *  tree routes; empty in the member tree until W5c. */
  workspaces: ListWorkspace[];
  /** A live open public link exists (the "Public" pill). */
  hasLink: boolean;
  /** A member's tree only: a draft rather than a brain item (folder plan
   *  phase 5). `own` is the member's own; `team` a teammate's draft shared
   *  with the team. Absent on a brain item. */
  source?: 'own' | 'team';
  /** A teammate's draft: who wrote it. */
  author?: string;
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
  /** Asked with `sort=custom`: the folder has a custom order (an item it
   *  lists carries a rank), so its items are in that order. Absent when they
   *  are in the kind's other sort, and from a brain before it. */
  ordered?: boolean;
  /** The caller may set this folder's order, of its items and its
   *  subfolders (POST /api/tree/:kind/place, a folder's `after`): Write on
   *  the folder, or an Admin scope at the top level. Absent from a brain
   *  before it. */
  mayOrder?: boolean;
  /** Pass back as `cursor` for the next page of items; null at the end. */
  nextCursor: string | null;
  /** Asked with `?ws=<id>` (ListWsEcho): the items are only those that
   *  workspace reads; the folders stay (the way to them). */
  ws?: string;
  /** Asked with `?ws=<id>`, on the first page of a folder where `ws` reads
   *  no item (task f26a516e): the caller's other workspaces that read items
   *  in this same folder, with how many, most first. Only workspaces the
   *  caller is a user of, and only items its scope reads. Absent when there
   *  are none, and from a brain before it. */
  elsewhere?: ElsewhereCount[];
};

/** Narrowing for GET /api/tree/:kind/search (`ws=`, `tag=`), the tree's
 *  filter menu. Both optional; together they both apply. A filtered search
 *  lists items only, no folders. The level filter went with the levels
 *  (W5b2). */
export type TreeFilter = {
  /** Only items this workspace reads (its id is in their read_ws). With
   *  `across`, the switcher's workspace instead: its items come first. */
  ws?: string;
  /** `across=1` (task f26a516e): a search with a term looks in every
   *  workspace the caller reads; `ws` then orders the items (its own
   *  first) and narrows nothing, and the folders that match come too. Each
   *  item names the workspace it opens in (`workspace`). An empty term (the
   *  A to Z view) ignores it. */
  across?: boolean;
  /** Only items carrying this tag. */
  tag?: string;
};
export const TREE_TAG_MAX = 100;

/** GET /api/tree/:kind/tags — the tags on a kind's items, most used first,
 *  for the filter menu. At most TREE_TAGS_LIST_MAX. */
export type TreeTagList = { kind: TreeKind; tags: Array<{ tag: string; count: number }> };
export const TREE_TAGS_LIST_MAX = 40;

/** GET /api/tree/:kind/search?q= — matching folders first, then items, each
 *  with the crumbs of where it lives. */
export type TreeSearchResult = {
  kind: TreeKind;
  folders: Array<TreeFolder & { crumbs: TreeCrumb[] }>;
  /** `workspace`: asked `across`, where the item opens (HitWorkspace). */
  items: Array<TreeItem & { crumbs: TreeCrumb[] } & HitWorkspaceField>;
  nextCursor: string | null;
  /** Asked with `?ws=<id>` (ListWsEcho). */
  ws?: string;
  /** Asked `across` with a term: the search covered every workspace the
   *  caller reads. Absent from a brain before it (which narrowed by `ws`). */
  across?: true;
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

/** One item a tree write would change (W5b2: in workspaces, from the
 *  grants). A new item is compared with one at the kind's root (Admin). */
export type TreeWorkspaceChange = {
  /** '' for an item not made yet (a create or upload). */
  id: string;
  title: string;
  /** "This will also be visible to: ..." */
  alsoVisibleTo: GrantWorkspaceRef[];
  /** The workspaces that would no longer read it. */
  removedFrom: GrantWorkspaceRef[];
  /** An item not made yet: the workspace it will be homed in (A0). */
  home?: GrantWorkspaceRef;
  /** An item not made yet: those of `alsoVisibleTo` that will read it but
   *  not edit it (a folder's rows with Write off, the folder's own home
   *  when the item is homed elsewhere). */
  readOnly?: GrantWorkspaceRef[];
};

/** A level change, as the member review's accept still lists it (until
 *  W5c). The tree's own refusal lists TreeWorkspaceChange. */
export type TreeVisibilityChange = {
  id: string;
  title: string;
  from: AccessLevel;
  to: AccessLevel;
  /** The item's node type ('file', 'table', 'note', 'branch', ...), sent in
   *  `alsoEmbeds`: an embed may open any workspace item, and a table
   *  opening is more than an image. Absent elsewhere. */
  type?: string;
};
/** A tree write that would change which workspaces read something (a
 *  folder moved or deleted with its contents lifted, items moved, a file or
 *  page made in a folder, a copy) is refused with this (409) until it is
 *  repeated with `confirm: true`. A confirm's `seen` is `total`. */
export type TreeVisibilityRefusal = {
  error: 'visibility';
  /** The first changes (at most TREE_VISIBILITY_LIST_MAX). */
  changes: TreeWorkspaceChange[];
  /** How many items change in all. */
  total: number;
  /** @deprecated Never sent since W5b2: embeds no longer open with what
   *  embeds them (grants are never added for you). */
  alsoEmbeds?: TreeVisibilityChange[];
  /** @deprecated Never sent since W5b2. */
  embedsTotal?: number;
  /** @deprecated Never sent: an unreleased first form of `alsoEmbeds`, when
   *  a share still lowered embeds for good. */
  alsoLowered?: TreeVisibilityChange[];
};
export const TREE_VISIBILITY_LIST_MAX = 100;

// ── The member and client trees ──────────────────────────────────────────
// A member (team) or client login browses the kinds its Library holds as a
// read-only tree: GET /api/member/tree/:kind and /api/client/tree/:kind (with
// /search), the kinds its shell lists in `treeKinds`. A member receives the
// shapes above (levels are staff information); a client receives these,
// which carry no level, share or system flag (clients see the brand, not the
// staff view). Folders show where the reader reads something below them or
// where a folder's share covers the reader; counts are the reader's.

/** A folder as a client login's tree shows it. */
export type ClientTreeFolder = Omit<
  TreeFolder,
  'share' | 'inherited' | 'system' | 'own' | 'workspaces' | 'hasLink'
>;
/** An item as a client login's tree shows it. */
export type ClientTreeItem = Omit<
  TreeItem,
  'level' | 'inherited' | 'embedded' | 'state' | 'source' | 'author' | 'workspaces' | 'hasLink'
>;

export type ClientTreeFolderPage = Omit<TreeFolderPage, 'folder' | 'folders' | 'items'> & {
  folder: ClientTreeFolder | null;
  folders: ClientTreeFolder[];
  items: ClientTreeItem[];
};

export type ClientTreeSearchResult = {
  kind: TreeKind;
  folders: Array<ClientTreeFolder & { crumbs: TreeCrumb[] }>;
  items: Array<ClientTreeItem & { crumbs: TreeCrumb[] }>;
  nextCursor: string | null;
};
