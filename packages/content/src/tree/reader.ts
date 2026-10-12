/**
 * The member and client trees (folder plan phase 4, "Folder visibility in the
 * tree"): a kind's folders and items as a member (team) or client login sees
 * them, read only.
 *
 * Items are read AS the reader (`withViewer` with its login, workspaces
 * W5b2): row security on the workspace role decides, so a member or a
 * client reads what a workspace of theirs holds (its grants), nothing by
 * level. Extracted image fragments are left out, as the Library leaves them
 * out.
 *
 * A folder shows when:
 *   - a workspace of the reader holds it (read as the reader, the same row
 *     security: so an empty subfolder of a held folder still shows), or
 *   - it is on the way to something the reader reads (names are
 *     organisational), or to such a held folder.
 * The folder rows themselves (names, looks) are read as the brain, along
 * those paths only. No stored state, no definer function: the visible set is
 * computed per call from the reader's item and folder paths. Counts are the
 * reader's (what it would see inside), never the brain's.
 *
 * Call it on the admin pool, outside any viewer scope: it scopes its own item
 * reads. (A member's own folders and drafts were merged in by ./member-tree,
 * removed in workspaces W8d with the personal spaces.)
 */
import { sql, type SQL } from 'drizzle-orm';
import { currentSpaceScope, db, withViewer, isSystemScope } from '@mantle/db';
import {
  TREE_KIND_SPECS,
  type ClientTreeFolder,
  type ClientTreeFolderPage,
  type ClientTreeItem,
  type ClientTreeSearchResult,
  type TreeFolder,
  type TreeFolderPage,
  type TreeItem,
  type TreeKind,
  type TreeSearchResult,
  type TreeSort,
} from '@mantle/client-types/tree';
import { treeFolderChain, treeParentPath } from '@mantle/content-core/tree';
import { encodeTreeCursor } from './cursor';
import { READER_TREE_KINDS } from './kinds';
import {
  itemPage,
  likePattern,
  searchItemRows,
  selectFolders,
  treeCrumbsFor,
  treeFolderById,
  treeItemFromRow,
  treePageLimit,
} from './read';

/** Who browses: a member login reads at team, a client login at client. */
export type TreeReader = 'team' | 'client';

function assertAdminScope(): void {
  if (!isSystemScope() || currentSpaceScope()) {
    throw new Error('reader tree called inside a viewer scope: call it on the admin pool');
  }
}

/** What the reader lists of a kind's items (`and ...` on alias `n`), read
 *  inside its workspace scope: row security decides which; extracted image
 *  fragments are left out. */
export function readerItems(alias: string): SQL {
  const a = sql.raw(alias);
  return sql`and not (${a}.type = 'file' and ${a}.data ? 'sourceFileId')`;
}

export type Visible = {
  /** The folder paths the reader sees. */
  paths: Set<string>;
  /** Readable items per path (the kind's root included). */
  items: Map<string, number>;
  /** Visible subfolders per path, counted once (a recount per folder over
   *  every visible path was quadratic: audit P2). */
  children: Map<string, number>;
};

export async function visibleFolders(
  anchorId: string,
  reader: TreeReader,
  loginId: string,
  kind: TreeKind,
): Promise<Visible> {
  const spec = TREE_KIND_SPECS[kind];
  const [itemRows, sharedRows] = await withViewer(reader, { login: loginId }, () =>
    Promise.all([
      db.execute(sql`
        select n.path::text as path, count(*)::int as n
          from nodes n
         where n.owner_id = ${anchorId} and n.type = ${spec.nodeType}
           and n.path <@ ${spec.root}::ltree ${readerItems('n')}
         group by n.path`) as unknown as Promise<Array<{ path: string; n: number }>>,
      // The folders a workspace of the reader holds: row security answers
      // those rows only.
      db.execute(sql`
        select f.path::text as path
          from nodes f
         where f.owner_id = ${anchorId} and f.type = 'branch'
           and f.path <@ ${spec.root}::ltree and nlevel(f.path) > 1`) as unknown as Promise<
        Array<{ path: string }>
      >,
    ]),
  );
  const paths = new Set<string>();
  for (const p of [...itemRows.map((r) => r.path), ...sharedRows.map((r) => r.path)]) {
    for (const c of treeFolderChain(p)) paths.add(c);
  }
  const children = new Map<string, number>();
  for (const p of paths) {
    const parent = treeParentPath(p);
    children.set(parent, (children.get(parent) ?? 0) + 1);
  }
  return { paths, items: new Map(itemRows.map((r) => [r.path, Number(r.n)])), children };
}

/** The folder with the reader's counts. */
function recount(f: TreeFolder, vis: Visible): TreeFolder {
  return {
    ...f,
    folderCount: vis.children.get(f.path) ?? 0,
    itemCount: vis.items.get(f.path) ?? 0,
  };
}

/**
 * One folder's page as the reader sees it: its visible subfolders and one
 * page of the items it reads there. `folderId` null is the kind's root. Null
 * when the kind is not a reader kind or the folder is not one the reader sees
 * (the same null as a missing folder).
 */
export async function loadReaderTreeFolder(
  anchorId: string,
  reader: TreeReader,
  loginId: string,
  kind: TreeKind,
  opts: { folderId?: string | null; cursor?: string | null; sort?: TreeSort; limit?: number } = {},
): Promise<TreeFolderPage | null> {
  assertAdminScope();
  if (!READER_TREE_KINDS.includes(kind)) return null;
  const spec = TREE_KIND_SPECS[kind];
  const sort = opts.sort && spec.sorts.includes(opts.sort) ? opts.sort : spec.sorts[0]!;
  const vis = await visibleFolders(anchorId, reader, loginId, kind);
  const found = opts.folderId ? await treeFolderById(anchorId, kind, opts.folderId) : null;
  if (opts.folderId && (!found || !vis.paths.has(found.path))) return null;
  const path = found?.path ?? spec.root;
  const [folders, crumbs, page] = await Promise.all([
    opts.cursor
      ? Promise.resolve([] as TreeFolder[])
      : selectFolders(anchorId, kind, sql`f.path ~ ${`${path}.*{1}`}::lquery`).then((all) =>
          all.filter((f) => vis.paths.has(f.path)).map((f) => recount(f, vis)),
        ),
    found
      ? treeCrumbsFor(anchorId, [treeParentPath(found.path)]).then(
          (m) => m.get(treeParentPath(found.path)) ?? [],
        )
      : Promise.resolve([]),
    withViewer(reader, { login: loginId }, () =>
      itemPage(
        anchorId,
        kind,
        path,
        sort,
        opts.cursor,
        treePageLimit(opts.limit),
        readerItems('n'),
      ),
    ),
  ]);
  return {
    kind,
    folder: found ? recount(found, vis) : null,
    crumbs,
    folders,
    items: page.items,
    sort,
    nextCursor: page.nextCursor,
  };
}

/**
 * Search as the reader: the matching folders it sees (first page only), then
 * the items it reads by name, each with where it lives. An empty `q` is the A
 * to Z view (items only). Null kinds answer nothing.
 */
export async function searchReaderTree(
  anchorId: string,
  reader: TreeReader,
  loginId: string,
  kind: TreeKind,
  q: string,
  opts: { cursor?: string | null; limit?: number } = {},
): Promise<TreeSearchResult> {
  assertAdminScope();
  if (!READER_TREE_KINDS.includes(kind)) return { kind, folders: [], items: [], nextCursor: null };
  const spec = TREE_KIND_SPECS[kind];
  const limit = treePageLimit(opts.limit);
  const term = q.trim();
  const vis = await visibleFolders(anchorId, reader, loginId, kind);
  const pattern = likePattern(term);
  const folders =
    opts.cursor || !term
      ? []
      : (
          await selectFolders(
            anchorId,
            kind,
            sql`f.path <@ ${spec.root}::ltree and nlevel(f.path) > 1
                and (f.title ilike ${pattern} or f.slug ilike ${pattern})`,
          )
        )
          .filter((f) => vis.paths.has(f.path))
          .slice(0, limit)
          .map((f) => recount(f, vis));
  const { page, more } = await withViewer(reader, { login: loginId }, () =>
    searchItemRows(anchorId, kind, term, opts.cursor, limit, readerItems('n')),
  );
  const crumbs = await treeCrumbsFor(anchorId, [
    ...folders.map((f) => treeParentPath(f.path)),
    ...page.map((r) => r.path),
  ]);
  const last = page.at(-1);
  return {
    kind,
    folders: folders.map((f) => ({ ...f, crumbs: crumbs.get(treeParentPath(f.path)) ?? [] })),
    items: page.map((r) => ({ ...treeItemFromRow(kind, r), crumbs: crumbs.get(r.path) ?? [] })),
    nextCursor:
      more && last
        ? encodeTreeCursor({ sort: 'name', key: String(last.sort_key), id: last.id })
        : null,
  };
}

// ── A client's shape: no level, share or system flag ───────────────────────

export function clientTreeFolder(f: TreeFolder): ClientTreeFolder {
  return {
    id: f.id,
    path: f.path,
    name: f.name,
    icon: f.icon,
    color: f.color,
    depth: f.depth,
    parentId: f.parentId,
    folderCount: f.folderCount,
    itemCount: f.itemCount,
  };
}

export function clientTreeItem(i: TreeItem): ClientTreeItem {
  return {
    id: i.id,
    title: i.title,
    icon: i.icon,
    color: i.color,
    subtype: i.subtype,
    updatedAt: i.updatedAt,
    ...(i.meta ? { meta: i.meta } : {}),
  };
}

export function clientTreeFolderPage(p: TreeFolderPage): ClientTreeFolderPage {
  return {
    kind: p.kind,
    folder: p.folder ? clientTreeFolder(p.folder) : null,
    crumbs: p.crumbs,
    folders: p.folders.map(clientTreeFolder),
    items: p.items.map(clientTreeItem),
    sort: p.sort,
    nextCursor: p.nextCursor,
  };
}

export function clientTreeSearch(r: TreeSearchResult): ClientTreeSearchResult {
  return {
    kind: r.kind,
    folders: r.folders.map((f) => ({ ...clientTreeFolder(f), crumbs: f.crumbs })),
    items: r.items.map((i) => ({ ...clientTreeItem(i), crumbs: i.crumbs })),
    nextCursor: r.nextCursor,
  };
}
