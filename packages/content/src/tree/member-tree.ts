/**
 * A member's tree (folder plan phase 5, "Members and clients"): one tree per
 * kind that merges, per path,
 *   - the brain's items the member reads (as the reader, ./reader), and
 *   - the member's own folders and drafts (rows its space owns at a brain
 *     folder path).
 * A member's own folders are private: only they see them. (Teammates' drafts
 * shared with the team were a third source; they went with team drafts in
 * workspaces W5c.)
 *
 * A brain folder shows only by the reader rules (./reader): a workspace of
 * the member holds it, or it leads to something the member reads. Where a member's
 * own folder sits at the path of a brain folder the member does NOT see, the
 * member's own row shows (its name, its id), never the brain's: a member
 * cannot learn a hidden folder's name, look or id by naming a folder like it
 * (folder audit 2026-09-30, S4). A member's rows that end up below a hidden
 * brain folder (the admin unshared or moved it) show at the deepest folder
 * above them the member sees, else at the top level.
 *
 * In a folder, drafts come before the brain's items, newest first, and page
 * like them: a folder's pages run through its drafts
 * first, then its brain items (a draft cursor, then the reader tree's keyset
 * cursor). By name (search and the A to Z view) drafts and brain items are
 * one list in one order, paged by one keyset cursor. A space holds at most
 * SPACE_ITEM_LIMIT items, so a member's own drafts are read whole.
 *
 * Files: a member's files and file folders sit under `space_files`, the
 * mirror of the brain's `files` (spaceFilesPath, @mantle/db), so no brain
 * file helper ever resolves them. This module speaks tree paths (`files...`)
 * and maps at the edge.
 *
 * Call it on the admin pool, outside any viewer scope: it scopes its own
 * reads (withSpace for the member's rows, withViewer for the brain's).
 */
import { sql } from 'drizzle-orm';
import {
  SPACE_FILES_ROOT,
  currentSpaceScope,
  db,
  spaceFilesPath,
  withViewer,
  isSystemScope,
} from '@mantle/db';
import {
  TREE_KIND_SPECS,
  type TreeCrumb,
  type TreeFolder,
  type TreeFolderPage,
  type TreeItem,
  type TreeItemState,
  type TreeKind,
  type TreeSearchResult,
  type TreeSort,
} from '@mantle/client-types/tree';
import { treeFolderChain, treeParentPath } from '@mantle/content-core/tree';
import { projectAppIcon, projectAppTint } from '@mantle/content-core/app-nav';
import { pillOf } from '../member-items';
import { SPACE_ITEM_LIMIT } from '../member-space-core';
import {
  decodeDraftCursor,
  decodeTreeCursor,
  encodeDraftCursor,
  encodeTreeCursor,
  type TreeCursor,
} from './cursor';
import { READER_TREE_KINDS, kindItemFilter } from './kinds';
import {
  itemPage,
  searchItemRows,
  selectFolders,
  treeItemFromRow,
  treePageLimit,
  type ItemSqlRow,
} from './read';
import { readerItems, visibleFolders } from './reader';

/** Who browses: the anchor (brain), and the member's space and login. */
export type MemberTreeScope = { anchorId: string; spaceId: string; loginId: string };

/** How many drafts of a kind are read at once: all a space can hold. */
const DRAFTS_MAX = SPACE_ITEM_LIMIT;

function assertAdminScope(): void {
  if (!isSystemScope() || currentSpaceScope()) {
    throw new Error('member tree called inside a viewer scope: call it on the admin pool');
  }
}

/** The tree path for a row's stored path (`space_files.a` is `files.a`). */
export function treePathOf(kind: TreeKind, stored: string): string {
  if (kind !== 'files') return stored;
  if (stored === SPACE_FILES_ROOT || stored.startsWith(`${SPACE_FILES_ROOT}.`)) {
    return TREE_KIND_SPECS.files.root + stored.slice(SPACE_FILES_ROOT.length);
  }
  return stored;
}

/** Where a member row at tree path `path` is stored. */
export function storedPathOf(kind: TreeKind, path: string): string {
  return kind === 'files' ? spaceFilesPath(path) : path;
}

/** The root a member's rows of `kind` sit under, as stored. */
function storedRoot(kind: TreeKind): string {
  return storedPathOf(kind, TREE_KIND_SPECS[kind].root);
}

type DraftRow = ItemSqlRow & {
  sharing: 'private' | 'team';
  review_state: string;
};

/** A draft, the tree path it shows at, and its name key as the database
 *  computed it (`lower(title)`): what the by-name order and its cursor
 *  compare, exactly as the brain's rows are compared. */
export type MemberDraft = { item: TreeItem; path: string; sortKey: string };

/** Everything a member's tree of one kind is drawn from. */
export type MemberView = {
  kind: TreeKind;
  /** The folder shown at each tree path (the brain's row when there is one,
   *  else the member's own). */
  byPath: Map<string, TreeFolder>;
  /** Every folder id the member may name: the shown folders, and the
   *  member's own folders merged under a brain folder of the same path. */
  byId: Map<string, TreeFolder>;
  /** The member's own folders by id (the ones it may change). */
  ownById: Map<string, TreeFolder>;
  /** The member's drafts, each at the tree path it shows at, newest first. */
  drafts: MemberDraft[];
  /** Brain items the member reads, per tree path. */
  brainItems: Map<string, number>;
  /** The brain folders' manual order (their place in selectFolders). */
  order: Map<string, number>;
};

function draftItem(kind: TreeKind, r: DraftRow): TreeItem {
  const item = treeItemFromRow(kind, r);
  const state = pillOf({
    sharing: r.sharing,
    reviewState: r.review_state as Parameters<typeof pillOf>[0]['reviewState'],
  });
  return { ...item, state: (state ?? null) as TreeItemState | null, source: 'own' };
}

function ownFolder(r: {
  id: string;
  path: string;
  title: string;
  data: Record<string, unknown> | null;
}): TreeFolder {
  const data = r.data ?? {};
  return {
    id: r.id,
    path: r.path,
    name: r.title,
    icon: projectAppIcon(data.icon) ?? null,
    color: projectAppTint(data.color) ?? null,
    depth: r.path.split('.').length - 1,
    parentId: null,
    share: null,
    inherited: null,
    system: false,
    folderCount: 0,
    itemCount: 0,
    own: true,
    workspaces: [],
    hasLink: false,
  };
}

const draftColumns = sql`n.id, n.path::text as path, n.title, n.data,
  n.updated_at, lower(n.title) as sort_key, si.sharing, si.review_state`;

/** The personal spaces were folded into the brain (workspaces W6b): nothing
 *  runs in one. @mantle/db's withSpace, which refused the same way, went in
 *  W8c; this keeps the refusal until the space code goes (W8d). */
async function withSpace<T>(_space: unknown, _fn: () => Promise<T>): Promise<T> {
  throw new Error(
    'withSpace: the personal spaces were folded into the brain (workspaces W6b); a login works in its private workspace',
  );
}

/** Read everything a member's tree of `kind` needs, once per call. */

export async function memberView(scope: MemberTreeScope, kind: TreeKind): Promise<MemberView> {
  assertAdminScope();
  const spec = TREE_KIND_SPECS[kind];
  const root = storedRoot(kind);
  const space = { spaceId: scope.spaceId, loginId: scope.loginId };
  const [vis, own] = await Promise.all([
    visibleFolders(scope.anchorId, 'team', scope.loginId, kind),
    withSpace(space, async () => {
      const folders = (await db.execute(sql`
        select id, path::text as path, title, data from nodes
         where owner_id = ${scope.spaceId} and type = 'branch'
           and path <@ ${root}::ltree and nlevel(path) > 1`)) as unknown as Array<{
        id: string;
        path: string;
        title: string;
        data: Record<string, unknown> | null;
      }>;
      const items = (await db.execute(sql`
        select ${draftColumns}
          from nodes n join space_items si on si.node_id = n.id
         where n.owner_id = ${scope.spaceId} and n.type = ${spec.nodeType}
           and n.path <@ ${root}::ltree ${kindItemFilter(kind, 'n')}
         order by n.updated_at desc, n.id
         limit ${DRAFTS_MAX}`)) as unknown as DraftRow[];
      return { folders, items };
    }),
  ]);

  const ownFolders = own.folders.map((r) => ownFolder({ ...r, path: treePathOf(kind, r.path) }));
  const ownItems = own.items.map((r) => ({ ...r, path: treePathOf(kind, r.path) }));

  // The paths that show: the brain folders the member sees by the reader
  // rules, and the member's own folders. A brain row shows only where the
  // member sees it; elsewhere the member's own row at that path does (never
  // the brain's name, look or id).
  const brainPaths = [...vis.paths];
  const brainRows = brainPaths.length
    ? await selectFolders(
        scope.anchorId,
        kind,
        sql`f.path = any(${`{${brainPaths.join(',')}}`}::ltree[])`,
      )
    : [];
  const brainByPath = new Map(brainRows.map((f) => [f.path, f]));

  const ownByPath = new Map(ownFolders.map((f) => [f.path, f]));
  const byPath = new Map<string, TreeFolder>();
  for (const p of new Set([...vis.paths, ...ownByPath.keys()])) {
    const shown = (vis.paths.has(p) ? brainByPath.get(p) : undefined) ?? ownByPath.get(p);
    if (shown) byPath.set(p, { ...shown });
  }
  // A folder only shows under a parent that shows (the top level aside).
  for (let pruned = true; pruned;) {
    pruned = false;
    for (const [p, f] of [...byPath]) {
      if (f.depth > 1 && !byPath.has(treeParentPath(p))) {
        byPath.delete(p);
        pruned = true;
      }
    }
  }

  /** The deepest shown folder at or above `path`; the root when none. */
  const shownAt = (path: string): string => {
    const chain = treeFolderChain(path);
    for (let i = chain.length - 1; i >= 0; i--) if (byPath.has(chain[i]!)) return chain[i]!;
    return TREE_KIND_SPECS[kind].root;
  };

  const drafts: MemberDraft[] = ownItems.map((r) => ({
    item: draftItem(kind, r),
    path: shownAt(r.path),
    sortKey: String(r.sort_key),
  }));

  // Parents and counts are this member's (one pass each: a brain with
  // thousands of visible folders stays linear).
  const draftsAt = new Map<string, number>();
  for (const d of drafts) draftsAt.set(d.path, (draftsAt.get(d.path) ?? 0) + 1);
  const childrenAt = new Map<string, number>();
  for (const p of byPath.keys()) {
    const parent = treeParentPath(p);
    childrenAt.set(parent, (childrenAt.get(parent) ?? 0) + 1);
  }
  for (const [p, f] of byPath) {
    f.parentId = f.depth > 1 ? (byPath.get(treeParentPath(p))?.id ?? null) : null;
    f.folderCount = childrenAt.get(p) ?? 0;
    f.itemCount = (vis.items.get(p) ?? 0) + (draftsAt.get(p) ?? 0);
  }

  const byId = new Map<string, TreeFolder>();
  for (const f of byPath.values()) byId.set(f.id, f);
  const ownById = new Map<string, TreeFolder>();
  for (const f of ownFolders) {
    const shown = byPath.get(f.path);
    if (!shown) continue;
    // Merged under a brain folder of the same path the member sees: the
    // member still names its own row by id, and changes it as its own.
    const mine = shown.id === f.id ? shown : { ...shown, id: f.id, own: true };
    ownById.set(f.id, mine);
    if (!byId.has(f.id)) byId.set(f.id, mine);
  }
  const order = new Map(brainRows.map((f, i) => [f.id, i]));
  return { kind, byPath, byId, ownById, drafts, brainItems: vis.items, order };
}

/** Brain folders in their manual order, then the member's own by name. */
function sortedFolders(view: MemberView, list: TreeFolder[]): TreeFolder[] {
  return list.sort((a, b) => {
    const oa = view.order.get(a.id);
    const ob = view.order.get(b.id);
    if (oa !== undefined && ob !== undefined) return oa - ob;
    if (oa !== undefined) return -1;
    if (ob !== undefined) return 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

function crumbsOf(view: MemberView, path: string): TreeCrumb[] {
  return treeFolderChain(path).flatMap((c) => {
    const f = view.byPath.get(c);
    return f ? [{ id: f.id, name: f.name }] : [];
  });
}

/**
 * One folder's page as the member sees it. `folderId` null is the kind's
 * root; a folder the member does not see is null (the same as a missing
 * one). Its pages run through the folder's drafts first, then the brain's
 * items; every page holds at most `limit` items.
 */
export async function loadMemberTreeFolder(
  scope: MemberTreeScope,
  kind: TreeKind,
  opts: { folderId?: string | null; cursor?: string | null; sort?: TreeSort; limit?: number } = {},
): Promise<TreeFolderPage | null> {
  assertAdminScope();
  if (!READER_TREE_KINDS.includes(kind)) return null;
  const spec = TREE_KIND_SPECS[kind];
  const sort = opts.sort && spec.sorts.includes(opts.sort) ? opts.sort : spec.sorts[0]!;
  const view = await memberView(scope, kind);
  const found = opts.folderId ? (view.byId.get(opts.folderId) ?? null) : null;
  if (opts.folderId && !found) return null;
  const path = found?.path ?? spec.root;
  const shown = found ? (view.byPath.get(path) ?? found) : null;
  const limit = treePageLimit(opts.limit);
  // Drafts first: no cursor, or a draft cursor, pages through them; a keyset
  // cursor is past them, in the brain's items.
  const shownDrafts = opts.cursor ? decodeDraftCursor(opts.cursor) : 0;
  const allDrafts = view.drafts.filter((d) => d.path === path).map((d) => d.item);
  const drafts = shownDrafts === null ? [] : allDrafts.slice(shownDrafts, shownDrafts + limit);
  const draftsLeft = shownDrafts !== null && shownDrafts + drafts.length < allDrafts.length;
  const room = limit - drafts.length;
  const page =
    draftsLeft || room === 0
      ? { items: [], nextCursor: null }
      : await withViewer({ login: scope.loginId }, () =>
          itemPage(
            scope.anchorId,
            kind,
            path,
            sort,
            shownDrafts === null ? opts.cursor : null,
            room,
            readerItems('n'),
          ),
        );
  const nextCursor = draftsLeft
    ? encodeDraftCursor(shownDrafts! + drafts.length)
    : room === 0
      ? encodeDraftCursor(allDrafts.length)
      : page.nextCursor;
  return {
    kind,
    folder: shown,
    crumbs: shown ? crumbsOf(view, treeParentPath(path)) : [],
    folders: opts.cursor
      ? []
      : sortedFolders(
          view,
          [...view.byPath.values()].filter(
            (f) => treeParentPath(f.path) === path && f.path !== path,
          ),
        ),
    items: [...drafts, ...page.items],
    sort,
    nextCursor,
  };
}

/**
 * The ids of `entries` that come after `cursor`, by name then id, at most
 * `limit`. The database orders them: drafts and the brain's rows are then
 * merged, and cut at the cursor, by the very comparison the brain's keyset
 * page uses (`(lower(title), id)` in the database's collation), which a
 * sort in JavaScript would not match.
 */
async function byNameAfter(
  entries: ReadonlyArray<{ id: string; k: string }>,
  cursor: TreeCursor | null,
  limit: number,
): Promise<string[]> {
  if (!entries.length) return [];
  const after = cursor ? sql`where (t.k, t.id) > (${cursor.key}, ${cursor.id}::uuid)` : sql``;
  const rows = (await db.execute(sql`
    select t.id::text as id
      from jsonb_to_recordset(${JSON.stringify(entries)}::jsonb) as t(id uuid, k text)
      ${after}
     order by t.k, t.id
     limit ${limit}`)) as unknown as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/**
 * Search as the member: the matching folders it sees (first page only), then
 * the items matching by name, its drafts and the brain's items it reads in
 * ONE order, by name, paged together by one keyset cursor. An empty `q` is
 * the A to Z view (items only): every draft and every item, by name. A page
 * holds at most `limit` items, so a member with more drafts than a page
 * reaches all of them.
 */
export async function searchMemberTree(
  scope: MemberTreeScope,
  kind: TreeKind,
  q: string,
  opts: { cursor?: string | null; limit?: number } = {},
): Promise<TreeSearchResult> {
  assertAdminScope();
  if (!READER_TREE_KINDS.includes(kind)) return { kind, folders: [], items: [], nextCursor: null };
  const limit = treePageLimit(opts.limit);
  const term = q.trim();
  const view = await memberView(scope, kind);
  const needle = term.toLowerCase();
  const cursor = decodeTreeCursor(opts.cursor, 'name');
  const folders =
    cursor || !term
      ? []
      : sortedFolders(
          view,
          [...view.byPath.values()].filter((f) => f.name.toLowerCase().includes(needle)),
        ).slice(0, limit);
  const drafts = view.drafts.filter((d) => !term || d.item.title.toLowerCase().includes(needle));
  // The brain's next `limit` rows after the cursor. Any row it holds beyond
  // them sorts after all of these, so the first `limit` of these and the
  // drafts together are the true next page.
  const { page, more } = await withViewer({ login: scope.loginId }, () =>
    searchItemRows(scope.anchorId, kind, term, opts.cursor, limit, readerItems('n')),
  );
  const found = new Map<string, { item: TreeItem; path: string; key: string }>();
  for (const d of drafts) found.set(d.item.id, { item: d.item, path: d.path, key: d.sortKey });
  for (const r of page) {
    found.set(r.id, { item: treeItemFromRow(kind, r), path: r.path, key: String(r.sort_key) });
  }
  const order = await byNameAfter(
    [...found].map(([id, f]) => ({ id, k: f.key })),
    cursor,
    limit + 1,
  );
  const shown = order.slice(0, limit).map((id) => found.get(id)!);
  const last = shown.at(-1);
  return {
    kind,
    folders: folders.map((f) => ({ ...f, crumbs: crumbsOf(view, treeParentPath(f.path)) })),
    items: shown.map((f) => ({ ...f.item, crumbs: crumbsOf(view, f.path) })),
    nextCursor:
      (more || order.length > limit) && last
        ? encodeTreeCursor({ sort: 'name', key: last.key, id: last.item.id })
        : null,
  };
}
