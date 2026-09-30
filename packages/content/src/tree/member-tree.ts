/**
 * A member's tree (folder plan phase 5, "Members and clients"): one tree per
 * kind that merges, per path,
 *   - the brain's items the member reads (as the reader, ./reader),
 *   - the member's own folders and drafts (rows its space owns at a brain
 *     folder path), and
 *   - teammates' drafts shared with the team.
 * A member's own folders are private: only they see them. A teammate's draft
 * shows at the deepest folder of its path that this member sees (never the
 * teammate's private folders), else at the top level.
 *
 * A brain folder shows only by the reader rules (./reader): its share covers
 * the member, or it leads to something the member reads. Where a member's
 * own folder sits at the path of a brain folder the member does NOT see, the
 * member's own row shows (its name, its id), never the brain's: a member
 * cannot learn a hidden folder's name, look or id by naming a folder like it
 * (folder audit 2026-09-30, S4). A member's rows that end up below a hidden
 * brain folder (the admin unshared or moved it) show at the deepest folder
 * above them the member sees, like a teammate's draft.
 *
 * Drafts come before the brain's items, newest first (own, then the team's),
 * and page like them: a folder's pages run through its drafts first, then
 * its brain items (a draft cursor, then the reader tree's keyset cursor). A
 * space holds at most SPACE_ITEM_LIMIT items, so a member's own drafts are
 * read whole; the team's newest SPACE_ITEM_LIMIT drafts of the kind are.
 *
 * Files: a member's files and file folders sit under `space_files`, the
 * mirror of the brain's `files` (spaceFilesPath, @mantle/db), so no brain
 * file helper ever resolves them. This module speaks tree paths (`files...`)
 * and maps at the edge.
 *
 * Call it on the admin pool, outside any viewer scope: it scopes its own
 * reads (withSpace for the member's rows, withTeamDrafts for the team's,
 * withViewer for the brain's).
 */
import { sql } from 'drizzle-orm';
import {
  SPACE_FILES_ROOT,
  currentSpaceScope,
  currentViewerLevel,
  db,
  spaceFilesPath,
  withSpace,
  withTeamDrafts,
  withViewer,
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
import { decodeDraftCursor, encodeDraftCursor, encodeTreeCursor } from './cursor';
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

/** How many drafts of a kind are read at once (own, and the team's): all a
 *  space can hold. */
const DRAFTS_MAX = SPACE_ITEM_LIMIT;

function assertAdminScope(): void {
  if (currentViewerLevel() !== 'admin' || currentSpaceScope()) {
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
  author_login_id: string | null;
};

export type MemberDraft = { item: TreeItem; path: string };

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
  /** Drafts, each at the tree path it shows at, own first, newest first. */
  drafts: MemberDraft[];
  /** Brain items the member reads, per tree path. */
  brainItems: Map<string, number>;
  /** The brain folders' manual order (their place in selectFolders). */
  order: Map<string, number>;
};

function draftItem(kind: TreeKind, r: DraftRow, source: 'own' | 'team', author?: string): TreeItem {
  const item = treeItemFromRow(kind, r);
  const state = pillOf({
    sharing: r.sharing,
    reviewState: r.review_state as Parameters<typeof pillOf>[0]['reviewState'],
  });
  return {
    ...item,
    state: (state ?? null) as TreeItemState | null,
    source,
    ...(author ? { author } : {}),
  };
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
  };
}

const draftColumns = sql`n.id, n.path::text as path, n.title, n.data, n.audience, n.inherited_level, n.embedded_level,
  n.updated_at, lower(n.title) as sort_key, si.sharing, si.review_state, si.author_login_id`;

/** Read everything a member's tree of `kind` needs, once per call. */
export async function memberView(scope: MemberTreeScope, kind: TreeKind): Promise<MemberView> {
  assertAdminScope();
  const spec = TREE_KIND_SPECS[kind];
  const root = storedRoot(kind);
  const space = { spaceId: scope.spaceId, loginId: scope.loginId };
  const [vis, own, team] = await Promise.all([
    visibleFolders(scope.anchorId, 'team', kind),
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
    withTeamDrafts(
      async () =>
        (await db.execute(sql`
          select ${draftColumns}
            from nodes n join space_items si on si.node_id = n.id
           where si.sharing = 'team' and mantle_member_space(n.owner_id)
             and si.author_login_id is distinct from ${scope.loginId}
             and n.type = ${spec.nodeType}
             and n.path <@ ${root}::ltree ${kindItemFilter(kind, 'n')}
           order by n.updated_at desc, n.id
           limit ${DRAFTS_MAX}`)) as unknown as DraftRow[],
    ),
  ]);

  const ownFolders = own.folders.map((r) => ownFolder({ ...r, path: treePathOf(kind, r.path) }));
  const ownItems = own.items.map((r) => ({ ...r, path: treePathOf(kind, r.path) }));
  const teamItems = team.map((r) => ({ ...r, path: treePathOf(kind, r.path) }));

  // The paths that show: the brain folders the member sees by the reader
  // rules, and the member's own folders. A brain row shows only where the
  // member sees it; elsewhere the member's own row at that path does (never
  // the brain's name, look or id). Teammates' drafts add no folder: they
  // show at the deepest folder above them the member sees.
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

  const names = await authorNames(teamItems.map((r) => r.author_login_id));
  const drafts: MemberDraft[] = [
    ...ownItems.map((r) => ({ item: draftItem(kind, r, 'own'), path: shownAt(r.path) })),
    ...teamItems.map((r) => ({
      item: draftItem(
        kind,
        r,
        'team',
        (r.author_login_id && names.get(r.author_login_id)) || 'A teammate',
      ),
      path: shownAt(r.path),
    })),
  ];

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

/** Display names for teammates' logins (a name a member sees on any team
 *  draft already). */
async function authorNames(ids: Array<string | null>): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((i): i is string => !!i))];
  if (!wanted.length) return new Map();
  const rows = (await db.execute(sql`
    select id, coalesce(nullif(trim(display_name), ''), split_part(email, '@', 1)) as name
      from auth.users
     where id in (${sql.join(
       wanted.map((i) => sql`${i}::uuid`),
       sql`, `,
     )})`)) as unknown as Array<{ id: string; name: string }>;
  return new Map(rows.map((r) => [r.id, r.name]));
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
      : await withViewer('team', () =>
          itemPage(
            scope.anchorId,
            kind,
            path,
            sort,
            shownDrafts === null ? opts.cursor : null,
            room,
            readerItems('team', 'n'),
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
 * Search as the member: matching folders it sees and the drafts matching by
 * name (first page only), then the brain's items it reads by name, paged.
 * An empty `q` is the A to Z view (items only).
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
  const folders =
    opts.cursor || !term
      ? []
      : sortedFolders(
          view,
          [...view.byPath.values()].filter((f) => f.name.toLowerCase().includes(needle)),
        ).slice(0, limit);
  const drafts = opts.cursor
    ? []
    : view.drafts
        .filter((d) => !term || d.item.title.toLowerCase().includes(needle))
        .slice(0, limit);
  const { page, more } = await withViewer('team', () =>
    searchItemRows(scope.anchorId, kind, term, opts.cursor, limit, readerItems('team', 'n')),
  );
  const last = page.at(-1);
  return {
    kind,
    folders: folders.map((f) => ({ ...f, crumbs: crumbsOf(view, treeParentPath(f.path)) })),
    items: [
      ...drafts.map((d) => ({ ...d.item, crumbs: crumbsOf(view, d.path) })),
      ...page.map((r) => ({ ...treeItemFromRow(kind, r), crumbs: crumbsOf(view, r.path) })),
    ],
    nextCursor:
      more && last
        ? encodeTreeCursor({ sort: 'name', key: String(last.sort_key), id: last.id })
        : null,
  };
}
