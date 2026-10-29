/**
 * The item tree's reads: one folder's page (its subfolders and one page of its
 * items), search, and the folder chain above a path. Everything a kind needs
 * comes from its spec, so one query shape serves every kind.
 *
 * Reads go through `db`, so a caller inside `withViewer` gets the row rules of
 * that reader for free; the counts and pages are then what that reader sees.
 */
import { sql, type SQL } from 'drizzle-orm';
import {
  db,
  folderTrail,
  folderTrailSql,
  trailForCaller,
  type TrailAsk,
  liveWorkspaceSql,
  nodeAliasReadBy,
  nodeAliasReadByAnyOf,
  nodeAliasReadByWorkspace,
  nodeAliasScopeReads,
} from '@mantle/db';
import type { ElsewhereCount } from '@mantle/client-types';
import { isUuid } from '@mantle/std';
import type {
  TreeCrumb,
  TreeFolder,
  TreeFolderPage,
  TreeItem,
  TreeKind,
  TreeSearchResult,
  TreeSort,
  TreeTagList,
} from '@mantle/client-types/tree';
import {
  TREE_KIND_SPECS,
  TREE_PAGE_MAX,
  TREE_PAGE_SIZE,
  TREE_TAGS_LIST_MAX,
} from '@mantle/client-types/tree';
import { projectAppIcon, projectAppTint } from '@mantle/content-core/app-nav';
import { treeFolderChain, treeParentPath } from '@mantle/content-core/tree';
import { decodeTreeCursor, encodeTreeCursor } from './cursor';
import { itemMeta, itemState, itemSubtype, kindItemFilter } from './kinds';
import { RANK_RE } from '../rank';

type FolderSqlRow = {
  id: string;
  path: string;
  title: string;
  data: Record<string, unknown> | null;
  parent_id: string | null;
  folder_count: number;
  item_count: number;
  /** Set only when the read narrowed by a workspace and named the
   *  caller's others (selectFolders `others`). */
  items_elsewhere?: number | null;
};

type ItemSqlRow = {
  id: string;
  path: string;
  title: string;
  data: Record<string, unknown> | null;
  updated_at: Date | string;
  sort_key: string;
};

function iso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

export function treeFolderFromRow(r: FolderSqlRow): TreeFolder {
  const data = r.data ?? {};
  return {
    id: r.id,
    path: r.path,
    name: r.title,
    icon: projectAppIcon(data.icon) ?? null,
    color: projectAppTint(data.color) ?? null,
    depth: r.path.split('.').length - 1,
    parentId: r.parent_id,
    system: data.system === true,
    folderCount: Number(r.folder_count),
    itemCount: Number(r.item_count),
    ...(r.items_elsewhere != null ? { itemsElsewhere: Number(r.items_elsewhere) } : {}),
    // Who reads it is the caller's to ask (lib/listWorkspaces.ts).
    workspaces: [],
    hasLink: false,
  };
}

function treeItemFromRow(kind: TreeKind, r: ItemSqlRow): TreeItem {
  const data = r.data ?? {};
  const meta = itemMeta(kind, data);
  return {
    id: r.id,
    title: r.title,
    icon: projectAppIcon(data.icon) ?? null,
    color: projectAppTint(data.color) ?? null,
    subtype: itemSubtype(kind, data),
    state: itemState(kind, data),
    updatedAt: iso(r.updated_at),
    ...(meta ? { meta } : {}),
    // Who reads it is the caller's to ask (lib/listWorkspaces.ts).
    workspaces: [],
    hasLink: false,
  };
}

/** Folder rows matching `where`, with the reader's counts and parent id,
 *  in the folder order: manual rank first, then name.
 *
 *  The counts are what the folder shows when the reader opens it in the
 *  same scope (the one count path): only what the reader's
 *  workspaces read (the row rules on a read; the caller's scope on the
 *  system pool, as in a write's reply), and `ws` (the switcher's workspace)
 *  keeps the items to what that workspace reads, as the item page does.
 *  The subfolders are not narrowed by `ws`: a folder list keeps every
 *  folder the reader reads (the way to the items). A folder the reader
 *  reads but whose contents it does not still shows, with 0. The parent
 *  id takes the same scope: a parent the reader does not read is null.
 *
 *  The parents and both counts are read once for all the folders, not once
 *  per folder: under a workspace scope the planner cannot see how many
 *  items the scope holds and guesses a handful, so each per-folder count
 *  re-read every item of the scope (an Admin user: 9 ms for 12 folders,
 *  1.5 ms read once; faster on the system pool too).
 *
 *  `others` (with `ws`): the caller's other workspaces. Each
 *  folder then also counts the items in it that one of them reads and `ws`
 *  does not (`itemsElsewhere`), under the same read rule, so a client can
 *  open a folder whose items all live in another workspace and say so.
 *  Both item counts come from one scan (`count(*) filter`); with no other
 *  workspace (none, or only `ws`) there is no second count at all.
 *
 *  `trail` (a login's own session in a workspace scope only, @mantle/db
 *  folderTrail, one definer call inside this statement; for any other caller
 *  the statement is the one before): the trail rows matching
 *  `where` that the reader does not read come too, as structure (id, path
 *  and name; no look, rank or system mark), and a trail folder serves as
 *  the parent of the folders below it. Each folder's subfolder count then
 *  counts the trail folders below it too (what opening it shows); the item
 *  counts stay what the reader reads. */
export async function selectFolders(
  ownerId: string,
  kind: TreeKind,
  where: SQL,
  ws?: string,
  others?: readonly string[],
  trail?: TrailAsk,
): Promise<TreeFolder[]> {
  const itemType = TREE_KIND_SPECS[kind].nodeType;
  const tr = trail ? folderTrailSql(ownerId, trail) : null;
  // The folders the reader reads, then (with a trail) the trail rows matched
  // by the same `where` (on id, path, title or slug; a trail row has no
  // slug) and not already listed.
  const folderRows = tr
    ? sql`f0 as materialized (
      select f.id, f.path, f.title, f.data from nodes f
       where f.owner_id = ${ownerId} and f.type = 'branch' and ${where}),
    tr as materialized (select tr.id, tr.path, tr.title from ${tr} tr),
    f as materialized (
      select f0.id, f0.path, f0.title, f0.data from f0
      union all
      select f.id, f.path, f.title, null::jsonb from (
        select tr.id, tr.path, tr.title, null::text as slug from tr) f
       where ${where} and f.id not in (select f0.id from f0))`
    : sql`f as materialized (
      select f.id, f.path, f.title, f.data from nodes f
       where f.owner_id = ${ownerId} and f.type = 'branch' and ${where})`;
  const trailParents = tr
    ? sql`
      union all
      select tr.id, tr.path from tr`
    : sql``;
  // The subfolders each folder shows when opened: the ones the reader reads
  // and, with a trail, the trail rows below it.
  const folderCounts = tr
    ? sql`
      select x.p, count(distinct x.id)::int as n from (
        select subpath(c.path, 0, nlevel(c.path) - 1) as p, c.id from nodes c
         where c.owner_id = ${ownerId} and c.type = 'branch' and nlevel(c.path) > 1
           and subpath(c.path, 0, nlevel(c.path) - 1) = any(array(select path from f))
           and ${nodeAliasScopeReads('c')}
        union all
        select subpath(tr.path, 0, nlevel(tr.path) - 1), tr.id from tr
         where nlevel(tr.path) > 2
           and subpath(tr.path, 0, nlevel(tr.path) - 1) = any(array(select path from f))) x
       group by 1`
    : sql`
      select subpath(c.path, 0, nlevel(c.path) - 1) as p, count(*)::int as n from nodes c
       where c.owner_id = ${ownerId} and c.type = 'branch' and nlevel(c.path) > 1
         and subpath(c.path, 0, nlevel(c.path) - 1) = any(array(select path from f))
         and ${nodeAliasScopeReads('c')}
       group by 1`;
  const elsewhere = ws ? elsewhereOf(ws, others ?? [], 'c') : null;
  // With `elsewhere`, one scan counts both: the items `ws` reads (`n`) and
  // those only the others read (`e`); a row neither reads is not scanned in.
  const counted =
    ws && elsewhere
      ? sql`count(*) filter (where ${nodeAliasReadByWorkspace(ws, 'c')})::int as n,
            count(*) filter (where ${elsewhere})::int as e`
      : sql`count(*)::int as n`;
  const itemWhere =
    ws && elsewhere
      ? sql`and (${nodeAliasReadByWorkspace(ws, 'c')} or ${elsewhere})`
      : readBy(ws, 'c');
  const rows = (await db.execute(sql`
    with ${folderRows},
    up as materialized (
      select p.id, p.path from nodes p
       where p.owner_id = ${ownerId} and p.type = 'branch' and ${nodeAliasScopeReads('p')}
         and p.path = any(array(
           select subpath(path, 0, nlevel(path) - 1) from f where nlevel(path) > 2))${trailParents}),
    fc as materialized (${folderCounts}),
    ic as materialized (
      select c.path as p, ${counted} from nodes c
       where c.owner_id = ${ownerId} and c.type = ${itemType}
         and c.path = any(array(select path from f)) ${kindItemFilter(kind, 'c')}
         and ${nodeAliasScopeReads('c')} ${itemWhere}
       group by 1)
    select f.id, f.path::text as path, f.title, f.data,
           (select up.id from up
             where nlevel(f.path) > 2 and up.path = subpath(f.path, 0, nlevel(f.path) - 1)
             limit 1) as parent_id,
           coalesce((select fc.n from fc where fc.p = f.path), 0) as folder_count,
           coalesce((select ic.n from ic where ic.p = f.path), 0) as item_count,
           ${
             elsewhere
               ? sql`coalesce((select ic.e from ic where ic.p = f.path), 0)`
               : // Asked (`ws` and `others`) with no other left: 0, not absent.
                 ws && others
                 ? sql`0`
                 : sql`null::int`
           } as items_elsewhere
      from f
     order by f.data->>'rank' collate "C" nulls last, lower(f.title), f.id`)) as unknown as FolderSqlRow[];
  return rows.map(treeFolderFromRow);
}

/** Every folder of a kind (all levels), in tree order: each folder's
 *  subfolders follow it, siblings in their manual order. For agents, which
 *  read the whole shape at once rather than a folder at a time. */
export async function listTreeFolders(ownerId: string, kind: TreeKind): Promise<TreeFolder[]> {
  const root = TREE_KIND_SPECS[kind].root;
  const all = await selectFolders(
    ownerId,
    kind,
    sql`f.path <@ ${root}::ltree and nlevel(f.path) > 1`,
  );
  const byParent = new Map<string | null, TreeFolder[]>();
  for (const f of all) {
    const list = byParent.get(f.parentId) ?? [];
    list.push(f);
    byParent.set(f.parentId, list);
  }
  const out: TreeFolder[] = [];
  const walk = (parentId: string | null) => {
    for (const f of byParent.get(parentId) ?? []) {
      out.push(f);
      walk(f.id);
    }
  };
  walk(null);
  return out;
}

/** One folder by id, when it is a folder of `kind` below the kind's root.
 *  `ws` and `others` count its items as selectFolders does. */
export async function treeFolderById(
  ownerId: string,
  kind: TreeKind,
  folderId: string,
  ws?: string,
  others?: readonly string[],
): Promise<TreeFolder | null> {
  const root = TREE_KIND_SPECS[kind].root;
  const [folder] = await selectFolders(
    ownerId,
    kind,
    sql`f.id = ${folderId} and f.path <@ ${root}::ltree and nlevel(f.path) > 1`,
    ws,
    others,
  );
  return folder ?? null;
}

/** The crumbs (top-down) for each of `paths`, keyed by path: the folders from
 *  the top level down to the path itself, root excluded. One query for all.
 *  For a login's own session the folders above what it reads that it does
 *  not read name their crumbs too (structure only, @mantle/db folderTrail),
 *  so the chain has no gap. */
export async function treeCrumbsFor(
  ownerId: string,
  paths: readonly string[],
): Promise<Map<string, TreeCrumb[]>> {
  const wanted = [...new Set(paths.flatMap((p) => treeFolderChain(p)))];
  const out = new Map<string, TreeCrumb[]>();
  if (!wanted.length) {
    for (const p of paths) out.set(p, []);
    return out;
  }
  const trail = folderTrailSql(ownerId, { paths: wanted });
  const rows = (await db.execute(sql`
    select id, path::text as path, title from nodes
     where owner_id = ${ownerId} and type = 'branch'
       and path::text in (${sql.join(
         wanted.map((w) => sql`${w}`),
         sql`, `,
       )})${
         trail
           ? sql`
    union
    select tr.id, tr.path::text as path, tr.title from ${trail} tr`
           : sql``
       }`)) as unknown as Array<{
    id: string;
    path: string;
    title: string;
  }>;
  const byPath = new Map(rows.map((r) => [r.path, { id: r.id, name: r.title }]));
  for (const p of paths) {
    out.set(
      p,
      treeFolderChain(p).flatMap((c) => {
        const hit = byPath.get(c);
        return hit ? [hit] : [];
      }),
    );
  }
  return out;
}

/** How an item order reads in SQL: the key expression and its direction. */
function sortOf(sort: TreeSort): { key: SQL; desc: boolean } {
  switch (sort) {
    case 'name':
      return { key: sql`lower(n.title)`, desc: false };
    case 'updated':
      return {
        key: sql`to_char(n.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`,
        desc: true,
      };
    case 'due':
      // Open tasks first, soonest due first, undated last; done tasks after.
      // The instant in UTC, not the stored text: '...T23:00+10:00' is before
      // '...T14:00Z', as the task list's own order has it.
      return {
        // Byte order (C collation): '~' sorts after every digit there, and
        // the cursor compares with the same collation as the order.
        key: sql`((case when n.data->>'status' = 'done' then '1' else '0' end
                  || coalesce(${utcKey(sql`n.data->>'due_at'`)}, '~')) collate "C")`,
        desc: false,
      };
    case 'start':
      return {
        key: sql`(coalesce(${utcKey(sql`n.data->>'starts_at'`)}, '') collate "C")`,
        desc: false,
      };
    case 'custom':
      return { key: treeItemOrderKey('n'), desc: false };
  }
}

/** The custom order of the items aliased `alias`: the rank, then the name.
 *  '~' (no rank) sorts after every rank digit, and the space after a whole
 *  rank before any longer one. */
export function treeItemOrderKey(alias: string): SQL {
  return sql`((${rankOf(alias)} || ' ' || lower(${sql.identifier(alias)}.title)) collate "C")`;
}

/** The ORDER BY of a folder's items (aliased `n`) as the tree lists them in
 *  `sort`, the id last. */
export function treeItemOrderBy(sort: TreeSort): SQL {
  const { key, desc } = sortOf(sort);
  return desc ? sql`${key} desc, n.id desc` : sql`${key} asc, n.id asc`;
}

/** An item's place in its folder's custom order (`data.tree_rank`, its own
 *  presentation key, 0337), or '~' when it has none or one that is not a
 *  rank. */
function rankOf(alias: string): SQL {
  const rank = sql`${sql.identifier(alias)}.data->>'tree_rank'`;
  return sql`(case when ${rank} ~ ${RANK_RE.source} then ${rank} else '~' end)`;
}

/** The order an unordered folder lists in under `custom`: the kind's first
 *  other sort, the order it had before custom orders. */
export function treeFallbackSort(kind: TreeKind): TreeSort {
  return TREE_KIND_SPECS[kind].sorts.find((s) => s !== 'custom')!;
}

/** Whether the folder at `path` has a custom order: an item there that the
 *  caller reads (and `ws` reads, when given) carries a `tree_rank`. A
 *  read-only snapshot copy's does not count: it is the rank it inherited,
 *  never one set by a place (write.ts orderChildren reads the same). */
export async function hasCustomOrder(
  ownerId: string,
  kind: TreeKind,
  path: string,
  extra: SQL = sql``,
): Promise<boolean> {
  const rows = (await db.execute(sql`
    select 1 from nodes n
     where n.owner_id = ${ownerId} and n.type = ${TREE_KIND_SPECS[kind].nodeType}
       and n.path = ${path}::ltree ${kindItemFilter(kind, 'n')} ${extra}
       and not (n.data ? 'snapshot_of')
       and n.data->>'tree_rank' ~ ${RANK_RE.source}
     limit 1`)) as unknown as unknown[];
  return rows.length > 0;
}

/** A stored ISO date or time as a sortable UTC text key (the same function
 *  the task and event lists sort by, mantle_iso_to_ts, migration 0025). */
function utcKey(iso: SQL): SQL {
  return sql`to_char(mantle_iso_to_ts(${iso}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`;
}

/** One page of the items directly in `path`. `extra` narrows the rows
 *  further (`and ...` on alias `n`): the member and client trees' levels. */
export async function itemPage(
  ownerId: string,
  kind: TreeKind,
  path: string,
  sort: TreeSort,
  cursorRaw: string | null | undefined,
  limit: number,
  extra: SQL = sql``,
): Promise<{ items: TreeItem[]; nextCursor: string | null }> {
  const { key, desc } = sortOf(sort);
  const cursor = decodeTreeCursor(cursorRaw, sort);
  const after = cursor
    ? desc
      ? sql`and (${key}, n.id) < (${cursor.key}, ${cursor.id}::uuid)`
      : sql`and (${key}, n.id) > (${cursor.key}, ${cursor.id}::uuid)`
    : sql``;
  const order = treeItemOrderBy(sort);
  const rows = (await db.execute(sql`
    select n.id, n.path::text as path, n.title, n.data, n.updated_at,
           ${key} as sort_key
      from nodes n
     where n.owner_id = ${ownerId} and n.type = ${TREE_KIND_SPECS[kind].nodeType}
       and n.path = ${path}::ltree ${kindItemFilter(kind, 'n')} ${extra} ${after}
     order by ${order}
     limit ${limit + 1}`)) as unknown as ItemSqlRow[];
  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  return {
    items: page.map((r) => treeItemFromRow(kind, r)),
    nextCursor:
      more && last ? encodeTreeCursor({ sort, key: String(last.sort_key), id: last.id }) : null,
  };
}

export function treePageLimit(raw: number | undefined): number {
  if (!raw || !Number.isFinite(raw)) return TREE_PAGE_SIZE;
  return Math.max(1, Math.min(TREE_PAGE_MAX, Math.floor(raw)));
}

/**
 * One folder's page: its direct subfolders (all of them, in order) and one
 * page of its items. `folderId` null is the kind's root. Null when the id is
 * not a folder of this kind. A cursor pages the items only; the folders come
 * with the first page. `ws` keeps only the items that workspace reads, in the
 * page and in the counts (the folders stay: they are the way to them).
 * `others` (with `ws`): the caller's other workspaces, for each folder's
 * `itemsElsewhere` (selectFolders) and the page's `elsewhere`.
 * For a login's own session the folders it does not read but that lead to
 * what it reads come too (selectFolders `trailUnder`), and such a folder
 * opens (its readable items, its subfolders, its full crumbs); nothing
 * else in it is shown.
 */
export async function loadTreeFolder(
  ownerId: string,
  kind: TreeKind,
  opts: {
    folderId?: string | null;
    cursor?: string | null;
    sort?: TreeSort;
    limit?: number;
    ws?: string;
    others?: readonly string[];
  } = {},
): Promise<TreeFolderPage | null> {
  const spec = TREE_KIND_SPECS[kind];
  const sort = opts.sort && spec.sorts.includes(opts.sort) ? opts.sort : spec.sorts[0]!;
  const root = TREE_KIND_SPECS[kind].root;
  const trailed = trailForCaller(ownerId);
  let folder = opts.folderId
    ? await treeFolderById(ownerId, kind, opts.folderId, opts.ws, opts.others)
    : null;
  // A folder the login does not read opens when it is on the way to
  // something it reads (the definer by id); every write still finds no
  // such folder.
  const hit =
    opts.folderId && !folder && trailed && isUuid(opts.folderId)
      ? (await folderTrail(ownerId, { folder: opts.folderId }))[0]
      : undefined;
  if (opts.folderId && !folder && !hit?.path.startsWith(`${root}.`)) return null;
  const path = folder?.path ?? hit?.path ?? spec.root;
  // What the page's statements ask the definer: the folder itself and its
  // parent when they are on the way and not read (the folder's row and its
  // parent id), and the folders on the way one and two levels below it.
  // `custom` lists by the folder's order when it has one, else as before.
  const ordered =
    sort === 'custom' && (await hasCustomOrder(ownerId, kind, path, readBy(opts.ws, 'n')));
  const itemSort = sort === 'custom' && !ordered ? treeFallbackSort(kind) : sort;
  const trail: TrailAsk = {
    under: path,
    paths: path.split('.').length > 2 ? [treeParentPath(path), path] : [path],
  };
  if (hit) {
    folder =
      (
        await selectFolders(
          ownerId,
          kind,
          sql`f.id = ${hit.id} and f.path <@ ${root}::ltree and nlevel(f.path) > 1`,
          opts.ws,
          opts.others,
          trail,
        )
      )[0] ?? null;
    if (!folder) return null;
  }
  const [folders, crumbs, page] = await Promise.all([
    opts.cursor
      ? Promise.resolve([] as TreeFolder[])
      : selectFolders(
          ownerId,
          kind,
          sql`f.path ~ ${`${path}.*{1}`}::lquery`,
          opts.ws,
          opts.others,
          trail,
        ),
    folder
      ? treeCrumbsFor(ownerId, [treeParentPath(folder.path)]).then(
          (m) => m.get(treeParentPath(folder.path)) ?? [],
        )
      : Promise.resolve([] as TreeCrumb[]),
    itemPage(
      ownerId,
      kind,
      path,
      itemSort,
      opts.cursor,
      treePageLimit(opts.limit),
      readBy(opts.ws, 'n'),
    ),
  ]);
  const elsewhere =
    opts.ws && opts.others?.length && !opts.cursor && page.items.length === 0
      ? await itemsElsewhereIn(ownerId, kind, path, opts.ws, opts.others)
      : [];
  return {
    kind,
    folder,
    crumbs,
    folders,
    items: page.items,
    sort,
    ...(sort === 'custom' ? { ordered } : {}),
    nextCursor: page.nextCursor,
    ...(elsewhere.length ? { elsewhere } : {}),
  };
}

/** Of a row aliased `alias`: `ws` does not read it and one of `others`
 *  does. `ws` and `others` are checked ids (the caller's
 *  own live workspaces, lib/list-workspaces.ts). Null when no other is
 *  left (none named, or only `ws`): nothing can be elsewhere, so a caller
 *  counts nothing rather than scanning for a match that cannot be. */
function elsewhereOf(ws: string, others: readonly string[], alias: string): SQL | null {
  const ids = others.filter((id) => isUuid(id) && id !== ws);
  if (!ids.length) return null;
  return sql`not ${nodeAliasReadByWorkspace(ws, alias)} and ${nodeAliasReadByAnyOf(ids, alias)}`;
}

/**
 * The items directly in the folder at `path` that `ws` does not read, by
 * each of the caller's `others` that reads them, most first (the hint under
 * an empty list, "2 items in Admin"). The read rule of the
 * caller's scope applies as on every tree read (the row rules in a
 * workspace scope; nodeAliasScopeReads on the system pool), so an item the
 * caller does not read is never counted, and only the named workspaces are
 * counted. An item two of them read counts in each.
 */
export async function itemsElsewhereIn(
  ownerId: string,
  kind: TreeKind,
  path: string,
  ws: string,
  others: readonly string[],
): Promise<ElsewhereCount[]> {
  const ids = others.filter((id) => isUuid(id) && id !== ws);
  if (!ids.length) return [];
  const rows = (await db.execute(sql`
    select w.id::text as id, w.name, count(*)::int as count
      from nodes n
      join workspaces w on ${nodeAliasReadBy(sql`w.id`, 'n')}
     where n.owner_id = ${ownerId} and n.type = ${TREE_KIND_SPECS[kind].nodeType}
       and n.path = ${path}::ltree ${kindItemFilter(kind, 'n')}
       and ${nodeAliasScopeReads('n')}
       and not ${nodeAliasReadByWorkspace(ws, 'n')}
       and w.id = any(${`{${ids.join(',')}}`}::uuid[])
       and w.owner_id = ${ownerId} and ${liveWorkspaceSql('w')}
     group by w.id, w.name
     order by count(*) desc, lower(w.name), w.id`)) as unknown as ElsewhereCount[];
  return rows.map((r) => ({ id: r.id, name: r.name, count: Number(r.count) }));
}

/** Only the items workspace `ws` reads (`and ...` on `alias`); every item
 *  without one. The item page, its search and the folder counts all take
 *  it from here. */
function readBy(ws: string | undefined, alias: string): SQL {
  return ws ? sql`and ${nodeAliasReadByWorkspace(ws, alias)}` : sql``;
}

/** `%` and `_` are ILIKE wildcards; a search for them means the characters. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * One page of a kind's items by name (A to Z), those whose title holds
 * `term` (all of them for an empty term). `extra` narrows further (`and ...`
 * on alias `n`). `first` (a checked workspace id): the items
 * that workspace reads come first, each part by name; the cursor's key then
 * carries the part ('0' first, '1' the rest) before the name.
 */
export async function searchItemRows(
  ownerId: string,
  kind: TreeKind,
  term: string,
  cursorRaw: string | null | undefined,
  limit: number,
  extra: SQL = sql``,
  first?: string,
): Promise<{ page: ItemSqlRow[]; more: boolean }> {
  const spec = TREE_KIND_SPECS[kind];
  const cursor = decodeTreeCursor(cursorRaw, 'name');
  const match = term ? sql`and n.title ilike ${likePattern(term)}` : sql``;
  const part = first
    ? sql`(case when ${nodeAliasReadByWorkspace(first, 'n')} then '0' else '1' end)`
    : null;
  const after = !cursor
    ? sql``
    : part
      ? sql`and (${part}, lower(n.title), n.id)
                > (${cursor.key.slice(0, 1)}, ${cursor.key.slice(1)}, ${cursor.id}::uuid)`
      : sql`and (lower(n.title), n.id) > (${cursor.key}, ${cursor.id}::uuid)`;
  const rows = (await db.execute(sql`
    select n.id, n.path::text as path, n.title, n.data, n.updated_at,
           ${part ? sql`${part} || lower(n.title)` : sql`lower(n.title)`} as sort_key
      from nodes n
     where n.owner_id = ${ownerId} and n.type = ${spec.nodeType}
       and n.path <@ ${spec.root}::ltree ${kindItemFilter(kind, 'n')}
       ${match} ${extra} ${after}
     order by ${part ? sql`${part}, ` : sql``}lower(n.title), n.id
     limit ${limit + 1}`)) as unknown as ItemSqlRow[];
  const more = rows.length > limit;
  return { page: more ? rows.slice(0, limit) : rows, more };
}

/** What a tree search covers, decided once by the route's
 *  gateway (parseReadCover, server/web/lib/list-workspaces.ts) and taken
 *  here as is:
 *  - `ws`: narrows the items to what that workspace reads; null, none.
 *  - `current`: the switcher's workspace; under `across` its items come
 *    first.
 *  - `across`: the search covers every workspace the caller reads (never
 *    with an empty term: the gateway says so, not this read). */
export type TreeSearchCover = { ws: string | null; current: string | null; across: boolean };

/**
 * Search a kind by name: matching folders first (at most one page, with their
 * crumbs), then items by name, paged. Both carry the crumbs of where they
 * live, so a result can be shown and opened in place. An empty `q` is the
 * A to Z view: every item of the kind by name, and no folders. A filter
 * (workspace, tag) narrows the items and drops the folders: it is a question
 * about items.
 *
 * `cover` (TreeSearchCover) says whether a workspace narrows
 * or orders. Across, the search covers what the caller's scope reads (the
 * row rules, as on every read here), the items `current` reads come first,
 * and the folders that match come too (unless a tag narrows). `across` is
 * echoed back.
 */
export async function searchTree(
  ownerId: string,
  kind: TreeKind,
  q: string,
  opts: {
    cursor?: string | null;
    limit?: number;
    tag?: string;
    cover?: TreeSearchCover;
  } = {},
): Promise<TreeSearchResult> {
  const spec = TREE_KIND_SPECS[kind];
  const limit = treePageLimit(opts.limit);
  const term = q.trim();
  const pattern = likePattern(term);
  const cursor = decodeTreeCursor(opts.cursor, 'name');
  const across = opts.cover?.across === true;
  const narrow = opts.cover?.ws ?? undefined;
  const first = across ? (opts.cover?.current ?? undefined) : undefined;
  const filtered = narrow !== undefined || opts.tag !== undefined;
  // Intended: across under a workspace, matching folders come too (the move picker gets them).
  const folders =
    cursor || !term || filtered
      ? []
      : (
          await selectFolders(
            ownerId,
            kind,
            sql`f.path <@ ${spec.root}::ltree and nlevel(f.path) > 1
                and (f.title ilike ${pattern} or f.slug ilike ${pattern})`,
          )
        ).slice(0, limit);
  const tag = opts.tag ? sql`and ${opts.tag} = any(n.tags)` : sql``;
  const { page, more } = await searchItemRows(
    ownerId,
    kind,
    term,
    opts.cursor,
    limit,
    sql`${readBy(narrow, 'n')} ${tag}`,
    first,
  );
  const crumbs = await treeCrumbsFor(ownerId, [
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
    ...(across ? { across: true as const } : {}),
  };
}

/**
 * The tags on a kind's items (under its root), most used first, for the
 * filter menu. The tag every item of the kind carries by default (its node
 * type: every file is tagged `file`) narrows nothing, so it is left out.
 * `ws` counts only the items that workspace reads, as the tree does.
 */
export async function listTreeTags(
  ownerId: string,
  kind: TreeKind,
  ws?: string,
): Promise<TreeTagList> {
  const spec = TREE_KIND_SPECS[kind];
  const rows = (await db.execute(sql`
    select t.tag, count(*)::int as count
      from nodes n, unnest(n.tags) as t(tag)
     where n.owner_id = ${ownerId} and n.type = ${spec.nodeType}
       and n.path <@ ${spec.root}::ltree and t.tag <> ${spec.nodeType}
       ${kindItemFilter(kind, 'n')} ${readBy(ws, 'n')}
     group by t.tag
     order by count(*) desc, t.tag
     limit ${TREE_TAGS_LIST_MAX}`)) as unknown as Array<{ tag: string; count: number }>;
  return { kind, tags: rows.map((r) => ({ tag: r.tag, count: Number(r.count) })) };
}

export { treeItemFromRow };
export type { ItemSqlRow };
