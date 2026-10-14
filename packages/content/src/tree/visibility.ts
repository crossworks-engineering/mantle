/**
 * What a tree write would change about which workspaces read items (folder
 * plan phase 4, "Confirm before visibility changes"; workspaces W5b2, S6).
 * Every write that places items under another folder (a folder or items
 * moved, a folder deleted with its contents lifted, a file or page made or
 * copied into a folder) is computed here first, DRY: nothing is written, so
 * a Files move (disk first) never has to be undone. When the answer is not
 * empty and the caller did not confirm, the write is refused with the list
 * (TreeVisibilityError, 409).
 *
 * The answer comes from the grants, as the move triggers derive them (0244,
 * mantle_rederive_nodes): an item placed in a folder takes the folder's rows
 * (not where the item has them "Removed here", only kinds that may take
 * them) and drops its folder-derived rows the new folder does not give. A
 * grant set on the item, its home and its exclusions stay. Inside a moved
 * folder, a change passes down to what is inside unless a folder on the way
 * stops it (its own grant keeps a workspace; its exclusion blocks one).
 * Embeds do not follow (0261): nothing is ever granted for you.
 */
import { sql, type SQL } from 'drizzle-orm';
import { currentCreateHome, db, itemWriteRefusal, scopeReadsItem } from '@mantle/db';
import { defineDomainError } from '@mantle/std';
import {
  TREE_KIND_SPECS,
  TREE_VISIBILITY_LIST_MAX,
  type TreeKind,
  type TreeShareLevel,
  type TreeVisibilityChange,
  type TreeWorkspaceChange,
} from '@mantle/client-types/tree';

type Via = Pick<typeof db, 'execute'>;

export type VisibilityDiff = {
  changes: TreeWorkspaceChange[];
  total: number;
  /** @deprecated Never set since W5b2 (embeds do not follow). */
  alsoEmbeds?: TreeVisibilityChange[];
  /** @deprecated Never set since W5b2. */
  embedsTotal?: number;
};

/** Everything a write changes: what a caller's `seen` is compared with. */
export function changeCount(d: VisibilityDiff): number {
  return d.total;
}

/** A write refused until it is repeated with `confirm: true`. */
export class TreeVisibilityError extends Error {
  constructor(readonly diff: VisibilityDiff) {
    super(
      `this would change who can see ${diff.total} item${diff.total === 1 ? '' : 's'}; ` +
        'repeat with confirm: true to go ahead',
    );
    this.name = 'TreeVisibilityError';
  }
}

// The one error answer (A10 part 2, @mantle/std domain-errors.ts): the
// list, so the caller can ask and repeat with confirm (what
// treeErrorResponse answered by hand).
defineDomainError(TreeVisibilityError, {
  reason: 'the write changes who can see items: the caller confirms first',
  status: 409,
  body: (e) => ({ error: 'visibility', changes: e.diff.changes, total: e.diff.total }),
});

export const NO_CHANGE: VisibilityDiff = { changes: [], total: 0 };

/** @deprecated Embeds no longer open with what embeds them (0261): there is
 *  nothing to add. Goes with the writers' last caller. */
export async function withEmbedChanges(
  _ownerId: string,
  diff: VisibilityDiff,
): Promise<VisibilityDiff> {
  return diff;
}

/** @deprecated Folder shares are frozen (0261): a share change is refused
 *  by the database, so it changes nothing here. Goes with setFolderShare. */
export function shareDiff(
  _ownerId: string,
  _folder: { id: string; path: string },
  _share: TreeShareLevel | null,
): Promise<VisibilityDiff> {
  return Promise.resolve(NO_CHANGE);
}

/** `ids` as a uuid[] parameter. */
function idArray(ids: readonly string[]): SQL {
  return sql`array[${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )}]::uuid[]`;
}

/** The grant rows of a folder (workspace_id, write, is_home, excluded),
 *  through the definer of 0279: the item_grants row rule hides a row of a
 *  workspace outside the scope, and the confirm names those too. */
function folderGrants(folder: SQL): SQL {
  return sql`mantle_folder_grant_rows(${folder})`;
}

/** The workspaces a folder passes on: its rows not removed there, that an
 *  item of `type` may take. None for no folder (a kind's root). */
function folderPasses(folder: SQL, type: SQL): SQL {
  return sql`array(
    select g.workspace_id from ${folderGrants(folder)} g
     where mantle_grant_kind_ok(${type}, g.workspace_id, true))`;
}

/** The workspaces a NEW item of `nodeType` at `destPath` is read in: the
 *  folder's rows and its home (the folder's home, else Admin), as the
 *  insert trigger gives them (0261 step 4). */
function newItemSet(ownerId: string, nodeType: string, destPath: string): SQL {
  const type = sql`${nodeType}::node_type`;
  const folder = sql`mantle_parent_folder(${ownerId}::uuid, ${type}, ${destPath}::ltree)`;
  return sql`array(select distinct x from unnest(
    ${folderPasses(folder, type)} || array[coalesce(
      (select f.home_ws from nodes f
        where f.id = ${folder} and mantle_ws_live(f.home_ws, f.id)
          and mantle_grant_kind_ok(${type}, f.home_ws)),
      mantle_ws_admin_id(${ownerId}::uuid))]
  ) as s(x) where x is not null)`;
}

/** The changed rows of `rows` (id, title, gain uuid[], lose uuid[], via:
 *  the folder the gain comes through), named,
 *  the first TREE_VISIBILITY_LIST_MAX by title, with the total. Only the
 *  rows the caller's scope reads (task b6e4a8aa): the list may run on the
 *  system pool inside a write, and must not name, or count, an item the
 *  caller cannot open. A new item (id '') is the caller's own.
 *
 *  It reads in the write's own transaction (`via`), its changes so far
 *  included (A2b2b fix round 1, M3). What a scoped read (the write role,
 *  the workspace role) cannot see goes through the definers of 0279, held
 *  to the scope: a destination folder's grant rows (folderGrants) and the
 *  workspaces the scope is not in (mantle_ws_names, mantle_ws_live,
 *  mantle_ws_admin_id). The grant rows of the items moved and of the
 *  folders on the way are read as the caller reads them: those diffs run
 *  before their write, through `db`, never inside a write transaction. */
async function listed(via: Via, rows: SQL): Promise<VisibilityDiff> {
  // A workspace is named when the scope may see it named for this change
  // (fix round 2, L4): what is gained through the folder (r.via), what is
  // lost from the item itself (r.id; none for a new item).
  const names = (col: SQL, through: SQL) => sql`mantle_ws_names(${col}, ${through})`;
  const found = (await via.execute(sql`
    select r.id::text as id, r.title,
           ${names(sql`r.gain`, sql`r.via`)} as "alsoVisibleTo",
           ${names(sql`r.lose`, sql`(nullif(r.id::text, ''))::uuid`)} as "removedFrom",
           count(*) over () as total
      from (${rows}) r
     where (cardinality(r.gain) > 0 or cardinality(r.lose) > 0)
       and (r.id::text = '' or ${scopeReadsItem(sql`(r.id::text)::uuid`)})
     order by lower(r.title), r.id
     limit ${TREE_VISIBILITY_LIST_MAX}`)) as unknown as Array<
    TreeWorkspaceChange & { total: number | string }
  >;
  return {
    changes: found.map(({ total: _total, ...c }) => c),
    total: Number(found[0]?.total ?? 0),
  };
}

/** Several diffs as one: the first TREE_VISIBILITY_LIST_MAX by title. */
function merged(diffs: VisibilityDiff[]): VisibilityDiff {
  const changes = diffs
    .flatMap((d) => d.changes)
    .sort((a, b) => {
      const ta = a.title.toLowerCase();
      const tb = b.title.toLowerCase();
      return ta < tb ? -1 : ta > tb ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .slice(0, TREE_VISIBILITY_LIST_MAX);
  return { changes, total: diffs.reduce((n, d) => n + d.total, 0) };
}

/** Rows (id, title, gain, lose) for items `where` (alias `n`) placed in the
 *  folder at `destPath` (S6, as grants.ts placeInFolder plans it). */
function placedRows(ownerId: string, where: SQL, destPath: string): SQL {
  const folder = sql`mantle_parent_folder(${ownerId}::uuid, n.type, ${destPath}::ltree)`;
  return sql`
    select n.id, n.title,
           array(select d.x from unnest(${folderPasses(folder, sql`n.type`)}) as d(x)
                  where not (d.x = any(n.read_ws))
                    and not exists (select 1 from item_grants e
                                     where e.node_id = n.id and e.workspace_id = d.x
                                       and e.excluded)) as gain,
           array(select g.workspace_id from item_grants g
                  where g.node_id = n.id and g.via_folder_id is not null
                    and not g.is_home and not g.excluded
                    and not (g.workspace_id = any(${folderPasses(folder, sql`n.type`)}))) as lose,
           ${folder} as via
      from nodes n
     where n.owner_id = ${ownerId} and n.type <> 'branch' and ${where}`;
}

/** Items of one kind moving into the folder at `destPath`. */
export function moveItemsDiff(
  ownerId: string,
  kind: TreeKind,
  itemIds: readonly string[],
  destPath: string,
): Promise<VisibilityDiff> {
  if (!itemIds.length) return Promise.resolve(NO_CHANGE);
  const nodeType = TREE_KIND_SPECS[kind].nodeType;
  return listed(
    db,
    placedRows(
      ownerId,
      sql`n.type::text = ${nodeType} and n.id = any(${idArray(itemIds)})`,
      destPath,
    ),
  );
}

/** A folder moving under `destParentPath`: the folder takes the new parent's
 *  rows and drops its folder-derived rows the new parent does not give;
 *  that change reaches everything inside it, unless a folder on the way
 *  stops it. */
export function moveFolderDiff(
  ownerId: string,
  folder: { id: string; path: string },
  destParentPath: string,
): Promise<VisibilityDiff> {
  const label = folder.path.split('.').at(-1)!;
  const newPath = `${destParentPath}.${label}`;
  const parent = sql`mantle_parent_folder(${ownerId}::uuid, 'branch'::node_type, ${newPath}::ltree)`;
  const passes = folderPasses(parent, sql`'branch'::node_type`);
  // Between the moved folder (excluded) and the item's own folder
  // (included): the folders the change passes through to reach `n`.
  const onTheWay = (cond: SQL) => sql`exists (
    select 1 from nodes a join item_grants ag on ag.node_id = a.id and ag.workspace_id = w.x
     where a.owner_id = n.owner_id and a.type = 'branch' and a.id <> f.id
       and a.path <@ f.path and a.path @> mantle_parent_folder_path(n.type, n.path)
       and ${cond})`;
  return listed(
    db,
    sql`
    with f as (select id, path, read_ws from nodes where id = ${folder.id} and owner_id = ${ownerId}),
    gain as (
      select x from unnest(${passes}) as p(x), f
       where not (x = any(f.read_ws))
         and not exists (select 1 from item_grants e
                          where e.node_id = f.id and e.workspace_id = x and e.excluded)),
    lose as (
      select g.workspace_id as x from item_grants g, f
       where g.node_id = f.id and g.via_folder_id is not null
         and not g.is_home and not g.excluded
         and not (g.workspace_id = any(${passes})))
    select n.id, n.title,
           case when n.id = f.id then array(select x from gain) else array(
             select w.x from gain w
              where not (w.x = any(n.read_ws))
                and mantle_grant_kind_ok(n.type, w.x, true)
                and not exists (select 1 from item_grants e
                                 where e.node_id = n.id and e.workspace_id = w.x and e.excluded)
                and not ${onTheWay(sql`ag.excluded`)})
           end as gain,
           case when n.id = f.id then array(select x from lose) else array(
             select w.x from lose w
              where w.x = any(n.read_ws)
                and exists (select 1 from item_grants e
                             where e.node_id = n.id and e.workspace_id = w.x
                               and e.via_folder_id is not null and not e.is_home
                               and not e.excluded)
                and not ${onTheWay(sql`not ag.excluded and ag.via_folder_id is null`)})
           end as lose,
           ${parent} as via
      from nodes n, f
     where n.owner_id = ${ownerId} and n.path <@ f.path`,
  );
}

/**
 * A folder deleted after its contents move up (write.ts deleteTreeFolder).
 * Everything below it lands one level up: its items go into the parent,
 * each subfolder moves under the parent, and a subfolder whose name is
 * already taken there MERGES into that folder, recursively (what merges in
 * takes that folder's rows). Each part is computed as the move it is.
 */
export async function liftDiff(
  ownerId: string,
  folder: { id: string; path: string },
): Promise<VisibilityDiff> {
  const parts: VisibilityDiff[] = [];
  const lift = async (src: string, dest: string): Promise<void> => {
    parts.push(await listed(db, placedRows(ownerId, sql`n.path = ${src}::ltree`, dest)));
    const subs = (await db.execute(sql`
      select s.id::text as id, s.path::text as path,
             exists (select 1 from nodes b
                      where b.owner_id = s.owner_id and b.type = 'branch'
                        and b.path = text2ltree(${dest}) || subpath(s.path, nlevel(s.path) - 1)
                        and not (b.path <@ ${folder.path}::ltree)) as merges
        from nodes s
       where s.owner_id = ${ownerId} and s.type = 'branch'
         and s.path ~ ${`${src}.*{1}`}::lquery`)) as unknown as Array<{
      id: string;
      path: string;
      merges: boolean;
    }>;
    for (const s of subs) {
      if (s.merges) await lift(s.path, `${dest}.${s.path.split('.').at(-1)!}`);
      else parts.push(await moveFolderDiff(ownerId, s, dest));
    }
  };
  await lift(folder.path, folder.path.split('.').slice(0, -1).join('.'));
  return merged(parts);
}

/**
 * A COPY of Files content landing under `destPath` (review F1): one file, or
 * every file of a folder's subtree. Copies are new rows that take where they
 * land (the folder's rows and its home, else Admin); grants inside the
 * source do not come along. Listed: each source file whose copy would be
 * read by a workspace that does not read the source now.
 */
export function copyDiff(
  ownerId: string,
  source: { fileId: string } | { folder: { id: string; path: string } },
  destPath: string,
): Promise<VisibilityDiff> {
  const which =
    'fileId' in source
      ? sql`n.id = ${source.fileId}::uuid`
      : sql`n.path <@ ${source.folder.path}::ltree`;
  return listed(
    db,
    sql`
    select n.id, n.title,
           array(select x from unnest(${newItemSet(ownerId, TREE_KIND_SPECS.files.nodeType, destPath)}) as s(x)
                  where not (x = any(n.read_ws))) as gain,
           '{}'::uuid[] as lose,
           mantle_parent_folder(${ownerId}::uuid, ${TREE_KIND_SPECS.files.nodeType}::node_type, ${destPath}::ltree) as via
      from nodes n
     where n.owner_id = ${ownerId} and n.type = 'file' and ${which}`,
  );
}

/**
 * A NEW item of `kind` (created or uploaded) in the folder at `destPath`,
 * against the same item at the kind's root (its home Admin, nothing else):
 * "This will also be visible to: ..." (S6). No change at the root, nor in a
 * folder only Admin reads.
 */
export async function newItemDiff(
  via: Via,
  ownerId: string,
  kind: TreeKind,
  destPath: string,
  title: string,
): Promise<VisibilityDiff> {
  const nodeType = TREE_KIND_SPECS[kind].nodeType;
  const set = newItemSet(ownerId, nodeType, destPath);
  // Empty when the brain has no Admin workspace (as the old array(select ...)).
  const admin = sql`array_remove(array[mantle_ws_admin_id(${ownerId}::uuid)], null)`;
  const diff = await listed(
    via,
    sql`
    select ''::text as id, ${title}::text as title,
           array(select x from unnest(${set}) as s(x) where not (x = any(${admin}))) as gain,
           array(select x from unnest(${admin}) as s(x) where not (x = any(${set}))) as lose,
           mantle_parent_folder(${ownerId}::uuid, ${nodeType}::node_type, ${destPath}::ltree) as via`,
  );
  const change = diff.changes[0];
  if (change) Object.assign(change, await newItemHome(via, ownerId, nodeType, destPath));
  return diff;
}

/**
 * Where a NEW item of `nodeType` in the folder at `destPath` will be homed,
 * and which of the folder's workspaces will read it without edit (A0 fix
 * round 3, L-c): the create home names the place (the current workspace a
 * caller moderates, else the folder's home when it may edit the folder,
 * else its private workspace; an Admin user: the folder's home, else
 * Admin), and the folder passes its rows with their Write (its home row
 * has Write off), as the insert trigger does (0261).
 */
async function newItemHome(
  via: Via,
  ownerId: string,
  nodeType: string,
  destPath: string,
): Promise<{
  home?: TreeWorkspaceChange['home'];
  readOnly: NonNullable<TreeWorkspaceChange['readOnly']>;
}> {
  const type = sql`${nodeType}::node_type`;
  const folder = sql`mantle_parent_folder(${ownerId}::uuid, ${type}, ${destPath}::ltree)`;
  const created = currentCreateHome();
  // Workspaces by definer (see listed).
  const live = (ws: SQL) =>
    sql`(select x.id from (select ${ws} as id) x
          where mantle_ws_live(x.id, ${folder}) and mantle_grant_kind_ok(${type}, x.id))`;
  // The folder's home through its home grant row (not the raw columns).
  const folderHome = live(
    sql`(select g.workspace_id from ${folderGrants(folder)} g where g.is_home)`,
  );
  let fallback: SQL = folderHome;
  if (created?.privateWs) {
    // A login outside Admin: the folder's home only when it may edit the
    // folder (the scope's own check), else its private workspace.
    const [f] = (await via.execute(sql`select ${folder}::text as id`)) as unknown as Array<{
      id: string | null;
    }>;
    const mayEdit = f?.id ? (await itemWriteRefusal([f.id], 'edit')) === null : false;
    fallback = mayEdit ? folderHome : live(sql`${created.privateWs}::uuid`);
  }
  const home = sql`coalesce(
    ${created?.createWs ? live(sql`${created.createWs}::uuid`) : sql`null::uuid`},
    ${fallback},
    mantle_ws_admin_id(${ownerId}::uuid))`;
  const [row] = (await via.execute(sql`
    with h as (select ${home} as ws)
    select (select mantle_ws_names(array[h.ws], ${folder}) -> 0 from h) as home,
           (select mantle_ws_names(array(
              select g.workspace_id from ${folderGrants(folder)} g, h
               where not g.write
                 and g.workspace_id <> h.ws
                 and mantle_grant_kind_ok(${type}, g.workspace_id, true)), ${folder})) as "readOnly"`)) as unknown as Array<{
    home: TreeWorkspaceChange['home'] | null;
    readOnly: NonNullable<TreeWorkspaceChange['readOnly']>;
  }>;
  return { ...(row?.home ? { home: row.home } : {}), readOnly: row?.readOnly ?? [] };
}
