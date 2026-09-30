/**
 * What a tree write would change about who can see items (folder plan phase
 * 4, "Confirm before visibility changes"). Every write that can move an item
 * under a different shared folder (a folder's share set or cleared, an item
 * or a folder moved, a folder deleted with its contents lifted) is computed
 * here first, DRY: nothing is written, so a Files move (disk first) never has
 * to be undone. When the answer is not empty and the caller did not confirm,
 * the write is refused with the list (TreeVisibilityError, 409).
 *
 * Levels compared are EFFECTIVE levels (content-core effectiveLevel): the
 * more open of an item's own level and its inherited share, the level its
 * pill shows. Only workspace kinds ever inherit (migration 0204), so the rest
 * never appear. A member's draft is another owner's row and never inherits.
 */
import { sql, type SQL } from 'drizzle-orm';
import { db, WORKSPACE_NODE_TYPES, type ViewerLevel } from '@mantle/db';
import { EMBEDDING_KINDS, embedClosure, levelAbove } from '../embed-closure';
import {
  TREE_KIND_SPECS,
  TREE_VISIBILITY_LIST_MAX,
  type TreeKind,
  type TreeShareLevel,
  type TreeVisibilityChange,
} from '@mantle/client-types/tree';
import type { AccessLevel } from '@mantle/client-types';

export type VisibilityDiff = {
  changes: TreeVisibilityChange[];
  total: number;
  /** Embedded items elsewhere that would go down with the changes (see
   *  TreeVisibilityRefusal.alsoLowered); filled in when a write is refused. */
  alsoLowered?: TreeVisibilityChange[];
};

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

export const NO_CHANGE: VisibilityDiff = { changes: [], total: 0 };

/**
 * What else a refused write would take down (TreeVisibilityRefusal
 * .alsoLowered): after a confirmed change, embeds follow each page, drawing
 * and note to the level it is then read at (write.ts followShares), and
 * those embeds may live anywhere. Dry, for the list only: for each such
 * change that opens an item up, the workspace-kind items of its embed
 * closure above its new level, outside the changes themselves.
 */
export async function withEmbedsGoingDown(
  ownerId: string,
  diff: VisibilityDiff,
): Promise<VisibilityDiff> {
  const opening = diff.changes.filter((c) =>
    levelAbove(c.from as ViewerLevel, c.to as ViewerLevel),
  );
  if (!opening.length) return diff;
  const kinds = (await db.execute(sql`
    select id::text as id from nodes
     where owner_id = ${ownerId} and type::text in (${sql.join(
       EMBEDDING_KINDS.map((k) => sql`${k}`),
       sql`, `,
     )})
       and id in (${sql.join(
         opening.map((c) => sql`${c.id}::uuid`),
         sql`, `,
       )})`)) as unknown as Array<{ id: string }>;
  const embedding = new Set(kinds.map((k) => k.id));
  const inDiff = new Set(diff.changes.map((c) => c.id));
  const workspace = new Set<string>(WORKSPACE_NODE_TYPES);
  const down = new Map<string, TreeVisibilityChange>();
  for (const c of opening) {
    if (!embedding.has(c.id)) continue;
    for (const e of await embedClosure(ownerId, c.id)) {
      if (inDiff.has(e.id) || !workspace.has(e.type)) continue;
      if (!levelAbove(e.audience, c.to as ViewerLevel)) continue;
      const seen = down.get(e.id);
      // The most open level wins when two changes embed the same item.
      if (seen && !levelAbove(seen.to as ViewerLevel, c.to as ViewerLevel)) continue;
      down.set(e.id, { id: e.id, title: e.title, from: e.audience, to: c.to });
    }
    if (down.size >= TREE_VISIBILITY_LIST_MAX) break;
  }
  return down.size ? { ...diff, alsoLowered: [...down.values()] } : diff;
}

/** effectiveLevel in SQL over two expressions. */
function eff(audience: SQL, inherited: SQL): SQL {
  return sql`(case
      when ${inherited} = 'client' and ${audience} in ('admin', 'team') then 'client'
      when ${inherited} = 'team' and ${audience} = 'admin' then 'team'
      else ${audience} end)`;
}

/** Run a query of rows (id, title, audience, old_inh, new_inh) and keep the
 *  ones whose effective level changes. */
async function diffOf(rows: SQL): Promise<VisibilityDiff> {
  const from = eff(sql`r.audience`, sql`r.old_inh`);
  const to = eff(sql`r.audience`, sql`r.new_inh`);
  const found = (await db.execute(sql`
    select r.id::text as id, r.title, ${from} as "from", ${to} as "to",
           count(*) over () as total
      from (${rows}) r
     where ${from} is distinct from ${to}
     order by lower(r.title), r.id
     limit ${TREE_VISIBILITY_LIST_MAX}`)) as unknown as Array<{
    id: string;
    title: string;
    from: AccessLevel;
    to: AccessLevel;
    total: number | string;
  }>;
  return {
    changes: found.map(({ id, title, from: f, to: t }) => ({ id, title, from: f, to: t })),
    total: Number(found[0]?.total ?? 0),
  };
}

/**
 * The rows of one owner's subtree at `path` (the folder itself excluded) with
 * the inherited share they would have if everything at or above `path` were
 * replaced by `replacement`: a row keeps its value when a nearer shared folder
 * inside the subtree (strictly below `path`, or at it too when `keepRoot`)
 * still holds it.
 */
function subtreeRows(
  ownerId: string,
  path: string,
  folderId: string,
  keepRoot: boolean,
  replacement: SQL,
): SQL {
  const inside = keepRoot ? sql`true` : sql`a.path <> ${path}::ltree`;
  return sql`
    select n.id, n.title, n.audience, n.inherited_level as old_inh,
      case
        when not mantle_workspace_kind(n.type) then null
        when exists (
          select 1 from nodes a
           where a.owner_id = n.owner_id and a.share_level is not null
             and a.path <@ ${path}::ltree and ${inside}
             and a.path @> n.path and (n.type <> 'branch' or a.path <> n.path)
        ) then n.inherited_level
        else ${replacement}
      end as new_inh
      from nodes n
     where n.owner_id = ${ownerId} and n.path <@ ${path}::ltree and n.id <> ${folderId}`;
}

/** Setting or clearing a folder's share. */
export function shareDiff(
  ownerId: string,
  folder: { id: string; path: string },
  share: TreeShareLevel | null,
): Promise<VisibilityDiff> {
  const fromAbove = sql`(select inherited_level from nodes where id = ${folder.id})`;
  const replacement = share ? sql`${share}::text` : fromAbove;
  return diffOf(subtreeRows(ownerId, folder.path, folder.id, false, replacement));
}

/** A folder moving under `destParentPath` (its own share, and every share
 *  inside it, moves with it). */
export function moveFolderDiff(
  ownerId: string,
  folder: { id: string; path: string },
  destParentPath: string,
): Promise<VisibilityDiff> {
  const label = folder.path.split('.').at(-1)!;
  const newPath = `${destParentPath}.${label}`;
  const replacement = sql`mantle_inherited_level(n.owner_id, ${newPath}::ltree, 'branch')`;
  return diffOf(subtreeRows(ownerId, folder.path, folder.id, true, replacement));
}

/**
 * A folder deleted after its contents move up (write.ts deleteTreeFolder).
 * Everything below it lands one level up: `P.rest` goes to `Q.rest`, where
 * `Q` is the parent. A subfolder whose landing path is already a folder
 * merges into it, so what it holds takes THAT folder's share; a subfolder
 * that moves keeps its own share and takes the shares above its new place.
 * Each row is compared at its real landing path, against the tree as it
 * will be: the shared folders outside the deleted one, plus the shared
 * subfolders that move (not the ones that merge away). Merged folder rows
 * are left out: they go.
 */
export function liftDiff(
  ownerId: string,
  folder: { id: string; path: string },
): Promise<VisibilityDiff> {
  const p = sql`${folder.path}::ltree`;
  const q = sql`${folder.path.split('.').slice(0, -1).join('.')}::ltree`;
  // subpath() cannot take a path down to nothing: a row at `P` lands at `Q`.
  const landing = (alias: string) => {
    const path = sql.raw(`${alias}.path`);
    return sql`(case when ${path} = ${p} then ${q} else ${q} || subpath(${path}, nlevel(${p})) end)`;
  };
  // A folder already at a landing path, outside the deleted subtree.
  const existingAt = (at: SQL) => sql`exists (
    select 1 from nodes b
     where b.owner_id = ${ownerId} and b.type = 'branch' and b.path = ${at}
       and not (b.path <@ ${p}))`;
  return diffOf(sql`
    with post as (
      select a.path, a.share_level from nodes a
       where a.owner_id = ${ownerId} and a.share_level is not null and not (a.path <@ ${p})
      union all
      select ${landing('s')}, s.share_level from nodes s
       where s.owner_id = ${ownerId} and s.share_level is not null
         and s.path <@ ${p} and s.id <> ${folder.id}
         and not ${existingAt(landing('s'))}
    )
    select n.id, n.title, n.audience, n.inherited_level as old_inh,
      case when not mantle_workspace_kind(n.type) then null else (
        select post.share_level from post
         where post.path @> ${landing('n')}
           and (n.type <> 'branch' or post.path <> ${landing('n')})
         order by nlevel(post.path) desc
         limit 1
      ) end as new_inh
      from nodes n
     where n.owner_id = ${ownerId} and n.path <@ ${p} and n.id <> ${folder.id}
       and not (n.type = 'branch' and ${existingAt(landing('n'))})`);
}

/** A level's openness for comparing in SQL (public most open). */
function openness(level: SQL): SQL {
  return sql`(case ${level} when 'public' then 0 when 'client' then 1 when 'team' then 2 else 3 end)`;
}

/**
 * A COPY of Files content landing under `destPath` (review F1): one file, or
 * every file of a folder's subtree. Copies are new rows at the admin level in
 * NEW, unshared folders, so they take whatever share covers where they land;
 * shares inside the source do not come along (unlike a move). Listed: each
 * source file whose copy would be read more openly than the source is now.
 */
export function copyDiff(
  ownerId: string,
  source: { fileId: string } | { folder: { id: string; path: string } },
  destPath: string,
): Promise<VisibilityDiff> {
  const newPath =
    'fileId' in source
      ? sql`${destPath}::ltree`
      : sql`(text2ltree(${destPath}) || subpath(n.path, nlevel(${source.folder.path}::ltree) - 1))`;
  const which =
    'fileId' in source
      ? sql`n.id = ${source.fileId}::uuid`
      : sql`n.path <@ ${source.folder.path}::ltree`;
  const from = eff(sql`n.audience`, sql`n.inherited_level`);
  const to = eff(sql`'admin'`, sql`mantle_inherited_level(n.owner_id, ${newPath}, 'file')`);
  return (async () => {
    const found = (await db.execute(sql`
      select r.id, r.title, r."from", r."to", count(*) over () as total
        from (select n.id::text as id, n.title, ${from} as "from", ${to} as "to"
                from nodes n
               where n.owner_id = ${ownerId} and n.type = 'file' and ${which}) r
       where ${openness(sql`r."to"`)} < ${openness(sql`r."from"`)}
       order by lower(r.title), r.id
       limit ${TREE_VISIBILITY_LIST_MAX}`)) as unknown as Array<{
      id: string;
      title: string;
      from: AccessLevel;
      to: AccessLevel;
      total: number | string;
    }>;
    return {
      changes: found.map(({ id, title, from: f, to: t }) => ({ id, title, from: f, to: t })),
      total: Number(found[0]?.total ?? 0),
    };
  })();
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
  return diffOf(sql`
    select n.id, n.title, n.audience, n.inherited_level as old_inh,
           mantle_inherited_level(n.owner_id, ${destPath}::ltree, n.type) as new_inh
      from nodes n
     where n.owner_id = ${ownerId} and n.type::text = ${nodeType}
       and n.id in (${sql.join(
         itemIds.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})`);
}
