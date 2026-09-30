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
 * pill shows. Only workspace kinds ever inherit (migration 0200), so the rest
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

export type VisibilityDiff = { changes: TreeVisibilityChange[]; total: number };

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

/** A folder deleted after its contents move up: its own share goes, what
 *  comes from above it stays. */
export function liftDiff(
  ownerId: string,
  folder: { id: string; path: string },
): Promise<VisibilityDiff> {
  const fromAbove = sql`(select inherited_level from nodes where id = ${folder.id})`;
  return diffOf(subtreeRows(ownerId, folder.path, folder.id, false, fromAbove));
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
