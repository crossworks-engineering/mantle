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
  TreeFilter,
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
 *  same scope (the one count path; task b6e4a8aa): only what the reader's
 *  workspaces read (the row rules on a read; the caller's scope on the
 *  system pool, as in a write's reply), and `ws` (the switcher's workspace)
 *  keeps the items to what that workspace reads, as the item page does.
 *  The subfolders are not narrowed by `ws`: a folder list keeps every
 *  folder the reader reads (the way to the items). A folder the reader
 *  reads but whose contents it does not still shows, with 0. The parent
 *  id takes the same scope: a parent the reader does not read is null.
 *
 *  The parents and both counts are read once for all the folders, not once
 *  per folder (W6a): under a workspace scope the planner cannot see how many
 *  items the scope holds and guesses a handful, so each per-folder count
 *  re-read every item of the scope (an Admin user: 9 ms for 12 folders,
 *  1.5 ms read once; faster on the system pool too).
 *
 *  `others` (with `ws`; task f26a516e): the caller's other workspaces. Each
 *  folder then also counts the items in it that one of them reads and `ws`
 *  does not (`itemsElsewhere`), under the same read rule, so a client can
 *  open a folder whose items all live in another workspace and say so. */
export async function selectFolders(
  ownerId: string,
  kind: TreeKind,
  where: SQL,
  ws?: string,
  others?: readonly string[],
): Promise<TreeFolder[]> {
  const itemType = TREE_KIND_SPECS[kind].nodeType;
  const elsewhere = ws && others ? elsewhereOf(ws, others, 'c') : null;
  const rows = (await db.execute(sql`
    with f as materialized (
      select f.id, f.path, f.title, f.data from nodes f
       where f.owner_id = ${ownerId} and f.type = 'branch' and ${where}),
    up as materialized (
      select p.id, p.path from nodes p
       where p.owner_id = ${ownerId} and p.type = 'branch' and ${nodeAliasScopeReads('p')}
         and p.path = any(array(
           select subpath(path, 0, nlevel(path) - 1) from f where nlevel(path) > 2))),
    fc as materialized (
      select subpath(c.path, 0, nlevel(c.path) - 1) as p, count(*)::int as n from nodes c
       where c.owner_id = ${ownerId} and c.type = 'branch' and nlevel(c.path) > 1
         and subpath(c.path, 0, nlevel(c.path) - 1) = any(array(select path from f))
         and ${nodeAliasScopeReads('c')}
       group by 1),
    ic as materialized (
      select c.path as p, count(*)::int as n from nodes c
       where c.owner_id = ${ownerId} and c.type = ${itemType}
         and c.path = any(array(select path from f)) ${kindItemFilter(kind, 'c')}
         and ${nodeAliasScopeReads('c')} ${readBy(ws, 'c')}
       group by 1)
    ${
      elsewhere
        ? sql`, ec as materialized (
      select c.path as p, count(*)::int as n from nodes c
       where c.owner_id = ${ownerId} and c.type = ${itemType}
         and c.path = any(array(select path from f)) ${kindItemFilter(kind, 'c')}
         and ${nodeAliasScopeReads('c')} and ${elsewhere}
       group by 1)`
        : sql``
    }
    select f.id, f.path::text as path, f.title, f.data,
           (select up.id from up
             where nlevel(f.path) > 2 and up.path = subpath(f.path, 0, nlevel(f.path) - 1)
             limit 1) as parent_id,
           coalesce((select fc.n from fc where fc.p = f.path), 0) as folder_count,
           coalesce((select ic.n from ic where ic.p = f.path), 0) as item_count,
           ${
             elsewhere
               ? sql`coalesce((select ec.n from ec where ec.p = f.path), 0)`
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
 *  the top level down to the path itself, root excluded. One query for all. */
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
  const rows = (await db.execute(sql`
    select id, path::text as path, title from nodes
     where owner_id = ${ownerId} and type = 'branch'
       and path::text in (${sql.join(
         wanted.map((w) => sql`${w}`),
         sql`, `,
       )})`)) as unknown as Array<{
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
      // '...T14:00Z' (audit C5), as the task list's own order has it.
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
  }
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
  const order = desc ? sql`${key} desc, n.id desc` : sql`${key} asc, n.id asc`;
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
  const folder = opts.folderId
    ? await treeFolderById(ownerId, kind, opts.folderId, opts.ws, opts.others)
    : null;
  if (opts.folderId && !folder) return null;
  const path = folder?.path ?? spec.root;
  const [folders, crumbs, page] = await Promise.all([
    opts.cursor
      ? Promise.resolve([] as TreeFolder[])
      : selectFolders(ownerId, kind, sql`f.path ~ ${`${path}.*{1}`}::lquery`, opts.ws, opts.others),
    folder
      ? treeCrumbsFor(ownerId, [treeParentPath(folder.path)]).then(
          (m) => m.get(treeParentPath(folder.path)) ?? [],
        )
      : Promise.resolve([] as TreeCrumb[]),
    itemPage(
      ownerId,
      kind,
      path,
      sort,
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
    nextCursor: page.nextCursor,
    ...(elsewhere.length ? { elsewhere } : {}),
  };
}

/** Of a row aliased `alias`: `ws` does not read it and one of `others`
 *  does (task f26a516e). `ws` and `others` are checked ids (the caller's
 *  own live workspaces, lib/list-workspaces.ts). */
function elsewhereOf(ws: string, others: readonly string[], alias: string): SQL {
  const ids = others.filter((id) => isUuid(id) && id !== ws);
  return sql`not ${nodeAliasReadByWorkspace(ws, alias)} and ${nodeAliasReadByAnyOf(ids, alias)}`;
}

/**
 * The items directly in the folder at `path` that `ws` does not read, by
 * each of the caller's `others` that reads them, most first (task f26a516e:
 * the hint under an empty list, "2 items in Admin"). The read rule of the
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
       and w.owner_id = ${ownerId} and w.archived_at is null
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
 * on alias `n`). `first` (a checked workspace id; task f26a516e): the items
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

/**
 * Search a kind by name: matching folders first (at most one page, with their
 * crumbs), then items by name, paged. Both carry the crumbs of where they
 * live, so a result can be shown and opened in place. An empty `q` is the
 * A to Z view: every item of the kind by name, and no folders. A filter
 * (workspace, tag) narrows the items and drops the folders: it is a question
 * about items.
 *
 * `across` with a term (task f26a516e): the workspace narrows nothing. The
 * search covers what the caller's scope reads (the row rules, as on every
 * read here), the items `ws` reads come first, and the folders that match
 * come too (unless a tag narrows). `across` is echoed back.
 */
export async function searchTree(
  ownerId: string,
  kind: TreeKind,
  q: string,
  opts: { cursor?: string | null; limit?: number } & TreeFilter = {},
): Promise<TreeSearchResult> {
  const spec = TREE_KIND_SPECS[kind];
  const limit = treePageLimit(opts.limit);
  const term = q.trim();
  const pattern = likePattern(term);
  const cursor = decodeTreeCursor(opts.cursor, 'name');
  const across = opts.across === true && term !== '';
  const narrow = across ? undefined : opts.ws;
  const filtered = narrow !== undefined || opts.tag !== undefined;
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
    across ? opts.ws : undefined,
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
