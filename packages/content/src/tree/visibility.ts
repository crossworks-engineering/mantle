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
 * most open of an item's own level, its inherited share and its embedded
 * level (migration 0208), the level its pill shows. Only workspace kinds ever inherit (migration 0204), so the rest
 * never appear. A member's draft is another owner's row and never inherits.
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from '@mantle/db';
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
  /** Embedded items elsewhere whose access changes with them (see
   *  TreeVisibilityRefusal.alsoEmbeds); filled in when a write is refused. */
  alsoEmbeds?: TreeVisibilityChange[];
  /** For each listed change, the folder share it would inherit: what its
   *  embeds would be read through. Internal, never sent. */
  newShares?: ReadonlyMap<string, string | null>;
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
 * What else a refused write changes (TreeVisibilityRefusal.alsoEmbeds): an
 * item read through a folder share makes what it embeds readable at that
 * share too, wherever that lives (nodes.embedded_level, migration 0208), and
 * an unshare or a move out takes that away again. Dry, for the list only:
 * the items the listed changes reach through embeds, each at the level it
 * would be read at with the new shares, where that differs from now.
 */
export async function withEmbedChanges(
  ownerId: string,
  diff: VisibilityDiff,
): Promise<VisibilityDiff> {
  const shares = diff.newShares;
  if (!shares?.size) return diff;
  const values = sql.join(
    [...shares].map(([id, level]) => sql`(${id}::uuid, ${level}::text)`),
    sql`, `,
  );
  const inherited = sql`(case when ov.id is not null then ov.lvl else m.inherited_level end)`;
  const found = (await db.execute(sql`
    with recursive ov(id, lvl) as (values ${values}),
    down(id) as (
      select e.to_id from node_embeds e join ov on e.from_id = ov.id
      union
      select e.to_id from node_embeds e
        join down on e.from_id = down.id
        join nodes x on x.id = down.id and x.owner_id = ${ownerId}
    ),
    tg as (
      select n.id, n.title, n.type, n.audience, n.inherited_level, n.embedded_level
        from nodes n join down on n.id = down.id
       where n.owner_id = ${ownerId} and mantle_workspace_kind(n.type)
         and not exists (select 1 from ov where ov.id = n.id)
    ),
    up(t, id) as (
      select tg.id, e.from_id from tg
        join node_embeds e on e.to_id = tg.id
        join nodes x on x.id = e.from_id and x.owner_id = ${ownerId}
      union
      select up.t, e.from_id from up
        join node_embeds e on e.to_id = up.id
        join nodes x on x.id = e.from_id and x.owner_id = ${ownerId}
    ),
    lv as (
      select up.t,
             case when bool_or(${inherited} = 'client') then 'client'
                  when bool_or(${inherited} = 'team') then 'team' end as emb
        from up
        join nodes m on m.id = up.id
        left join ov on ov.id = m.id
       where m.id <> up.t
       group by up.t
    )
    select r.id::text as id, r.title, r."from", r."to", r.type from (
      select tg.id, tg.title, tg.type::text as type,
             ${eff(sql`tg.audience`, sql`tg.inherited_level`, sql`tg.embedded_level`)} as "from",
             ${eff(sql`tg.audience`, sql`tg.inherited_level`, sql`lv.emb`)} as "to"
        from tg left join lv on lv.t = tg.id) r
     where r."from" is distinct from r."to"
     order by lower(r.title), r.id
     limit ${TREE_VISIBILITY_LIST_MAX}`)) as unknown as TreeVisibilityChange[];
  return found.length ? { ...diff, alsoEmbeds: found } : diff;
}

/** effectiveLevel in SQL: the most open of an own level and two shares. */
function eff(audience: SQL, inherited: SQL, embedded: SQL): SQL {
  return sql`(case
      when 'client' in (${inherited}, ${embedded}) and ${audience} in ('admin', 'team') then 'client'
      when 'team' in (${inherited}, ${embedded}) and ${audience} = 'admin' then 'team'
      else ${audience} end)`;
}

/** Run a query of rows (id, title, audience, emb, old_inh, new_inh) and keep
 *  the ones whose effective level changes. The embedded level is as it is
 *  now: what changes through embeds is listed apart (withEmbedChanges). */
async function diffOf(rows: SQL): Promise<VisibilityDiff> {
  const from = eff(sql`r.audience`, sql`r.old_inh`, sql`r.emb`);
  const to = eff(sql`r.audience`, sql`r.new_inh`, sql`r.emb`);
  const found = (await db.execute(sql`
    select r.id::text as id, r.title, ${from} as "from", ${to} as "to", r.new_inh,
           count(*) over () as total
      from (${rows}) r
     where ${from} is distinct from ${to}
     order by lower(r.title), r.id
     limit ${TREE_VISIBILITY_LIST_MAX}`)) as unknown as Array<{
    id: string;
    title: string;
    from: AccessLevel;
    to: AccessLevel;
    new_inh: string | null;
    total: number | string;
  }>;
  return {
    changes: found.map(({ id, title, from: f, to: t }) => ({ id, title, from: f, to: t })),
    total: Number(found[0]?.total ?? 0),
    ...(found.length ? { newShares: new Map(found.map((r) => [r.id, r.new_inh])) } : {}),
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
    select n.id, n.title, n.audience, n.embedded_level as emb, n.inherited_level as old_inh,
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
    select n.id, n.title, n.audience, n.embedded_level as emb, n.inherited_level as old_inh,
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
  const from = eff(sql`n.audience`, sql`n.inherited_level`, sql`n.embedded_level`);
  // A copy is a new row: nothing embeds it yet.
  const to = eff(
    sql`'admin'`,
    sql`mantle_inherited_level(n.owner_id, ${newPath}, 'file')`,
    sql`null::text`,
  );
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
    select n.id, n.title, n.audience, n.embedded_level as emb, n.inherited_level as old_inh,
           mantle_inherited_level(n.owner_id, ${destPath}::ltree, n.type) as new_inh
      from nodes n
     where n.owner_id = ${ownerId} and n.type::text = ${nodeType}
       and n.id in (${sql.join(
         itemIds.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})`);
}
