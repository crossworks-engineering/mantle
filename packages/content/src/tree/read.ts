/**
 * The item tree's reads: one folder's page (its subfolders and one page of its
 * items), search, and the folder chain above a path. Everything a kind needs
 * comes from its spec, so one query shape serves every kind.
 *
 * Reads go through `db`, so a caller inside `withViewer` gets the row rules of
 * that reader for free; the counts and pages are then what that reader sees.
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from '@mantle/db';
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
import type { AccessLevel } from '@mantle/client-types';
import { decodeTreeCursor, encodeTreeCursor } from './cursor';
import { itemMeta, itemSubtype, kindItemFilter } from './kinds';

type FolderSqlRow = {
  id: string;
  path: string;
  title: string;
  data: Record<string, unknown> | null;
  parent_id: string | null;
  folder_count: number;
  item_count: number;
};

type ItemSqlRow = {
  id: string;
  path: string;
  title: string;
  data: Record<string, unknown> | null;
  audience: string;
  updated_at: Date | string;
  sort_key: string;
};

function iso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function asLevel(v: string): AccessLevel {
  return v === 'team' || v === 'client' || v === 'public' ? v : 'admin';
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
    share: null,
    system: data.system === true,
    folderCount: Number(r.folder_count),
    itemCount: Number(r.item_count),
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
    level: asLevel(r.audience),
    state: null,
    updatedAt: iso(r.updated_at),
    ...(meta ? { meta } : {}),
  };
}

/** Folder rows matching `where`, with the reader's counts and parent id,
 *  in the folder order: manual rank first, then name. */
async function selectFolders(ownerId: string, kind: TreeKind, where: SQL): Promise<TreeFolder[]> {
  const itemType = TREE_KIND_SPECS[kind].nodeType;
  const rows = (await db.execute(sql`
    select f.id, f.path::text as path, f.title, f.data,
           (select p.id from nodes p
             where p.owner_id = f.owner_id and p.type = 'branch'
               and nlevel(f.path) > 2
               and p.path = subpath(f.path, 0, nlevel(f.path) - 1)
             limit 1) as parent_id,
           (select count(*)::int from nodes c
             where c.owner_id = f.owner_id and c.type = 'branch'
               and c.path ~ (f.path::text || '.*{1}')::lquery) as folder_count,
           (select count(*)::int from nodes c
             where c.owner_id = f.owner_id and c.type = ${itemType}
               and c.path = f.path ${kindItemFilter(kind, 'c')}) as item_count
      from nodes f
     where f.owner_id = ${ownerId} and f.type = 'branch' and ${where}
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

/** One folder by id, when it is a folder of `kind` below the kind's root. */
export async function treeFolderById(
  ownerId: string,
  kind: TreeKind,
  folderId: string,
): Promise<TreeFolder | null> {
  const root = TREE_KIND_SPECS[kind].root;
  const [folder] = await selectFolders(
    ownerId,
    kind,
    sql`f.id = ${folderId} and f.path <@ ${root}::ltree and nlevel(f.path) > 1`,
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
      return {
        // Byte order (C collation): '~' sorts after every digit there, and
        // the cursor compares with the same collation as the order.
        key: sql`((case when n.data->>'status' = 'done' then '1' else '0' end
                  || coalesce(n.data->>'due_at', '~')) collate "C")`,
        desc: false,
      };
    case 'start':
      return { key: sql`(coalesce(n.data->>'starts_at', '') collate "C")`, desc: false };
  }
}

/** One page of the items directly in `path`. */
async function itemPage(
  ownerId: string,
  kind: TreeKind,
  path: string,
  sort: TreeSort,
  cursorRaw: string | null | undefined,
  limit: number,
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
    select n.id, n.path::text as path, n.title, n.data, n.audience, n.updated_at,
           ${key} as sort_key
      from nodes n
     where n.owner_id = ${ownerId} and n.type = ${TREE_KIND_SPECS[kind].nodeType}
       and n.path = ${path}::ltree ${kindItemFilter(kind, 'n')} ${after}
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
 * with the first page.
 */
export async function loadTreeFolder(
  ownerId: string,
  kind: TreeKind,
  opts: { folderId?: string | null; cursor?: string | null; sort?: TreeSort; limit?: number } = {},
): Promise<TreeFolderPage | null> {
  const spec = TREE_KIND_SPECS[kind];
  const sort = opts.sort && spec.sorts.includes(opts.sort) ? opts.sort : spec.sorts[0]!;
  const folder = opts.folderId ? await treeFolderById(ownerId, kind, opts.folderId) : null;
  if (opts.folderId && !folder) return null;
  const path = folder?.path ?? spec.root;
  const [folders, crumbs, page] = await Promise.all([
    opts.cursor
      ? Promise.resolve([] as TreeFolder[])
      : selectFolders(ownerId, kind, sql`f.path ~ ${`${path}.*{1}`}::lquery`),
    folder
      ? treeCrumbsFor(ownerId, [treeParentPath(folder.path)]).then(
          (m) => m.get(treeParentPath(folder.path)) ?? [],
        )
      : Promise.resolve([] as TreeCrumb[]),
    itemPage(ownerId, kind, path, sort, opts.cursor, treePageLimit(opts.limit)),
  ]);
  return {
    kind,
    folder,
    crumbs,
    folders,
    items: page.items,
    sort,
    nextCursor: page.nextCursor,
  };
}

/** `%` and `_` are ILIKE wildcards; a search for them means the characters. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Search a kind by name: matching folders first (at most one page, with their
 * crumbs), then items by name, paged. Both carry the crumbs of where they
 * live, so a result can be shown and opened in place. An empty `q` is the
 * A to Z view: every item of the kind by name, and no folders. A filter
 * (level, tag) narrows the items and drops the folders: it is a question
 * about items.
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
  const filtered = opts.level !== undefined || opts.tag !== undefined;
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
  const match = term ? sql`and n.title ilike ${pattern}` : sql``;
  // Phase 1 has no folder shares, so an item's own level is the level it is
  // read at. The inherited level joins this with sharing (phase 4).
  const level = opts.level ? sql`and n.audience = ${opts.level}` : sql``;
  const tag = opts.tag ? sql`and ${opts.tag} = any(n.tags)` : sql``;
  const after = cursor
    ? sql`and (lower(n.title), n.id) > (${cursor.key}, ${cursor.id}::uuid)`
    : sql``;
  const rows = (await db.execute(sql`
    select n.id, n.path::text as path, n.title, n.data, n.audience, n.updated_at,
           lower(n.title) as sort_key
      from nodes n
     where n.owner_id = ${ownerId} and n.type = ${spec.nodeType}
       and n.path <@ ${spec.root}::ltree ${kindItemFilter(kind, 'n')}
       ${match} ${level} ${tag} ${after}
     order by lower(n.title), n.id
     limit ${limit + 1}`)) as unknown as ItemSqlRow[];
  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
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
  };
}

/**
 * The tags on a kind's items (under its root), most used first, for the
 * filter menu. The tag every item of the kind carries by default (its node
 * type: every file is tagged `file`) narrows nothing, so it is left out.
 */
export async function listTreeTags(ownerId: string, kind: TreeKind): Promise<TreeTagList> {
  const spec = TREE_KIND_SPECS[kind];
  const rows = (await db.execute(sql`
    select t.tag, count(*)::int as count
      from nodes n, unnest(n.tags) as t(tag)
     where n.owner_id = ${ownerId} and n.type = ${spec.nodeType}
       and n.path <@ ${spec.root}::ltree and t.tag <> ${spec.nodeType}
       ${kindItemFilter(kind, 'n')}
     group by t.tag
     order by count(*) desc, t.tag
     limit ${TREE_TAGS_LIST_MAX}`)) as unknown as Array<{ tag: string; count: number }>;
  return { kind, tags: rows.map((r) => ({ tag: r.tag, count: Number(r.count) })) };
}

export { treeItemFromRow };
export type { ItemSqlRow };
