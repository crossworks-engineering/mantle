/**
 * A member's writes in its tree (folder plan phase 5): its own private
 * folders (create, rename, restyle, move, delete) and filing its own drafts.
 *
 * Where a member may put something: any folder its tree shows (a brain folder
 * it reads something in or below, or one of its own), or the top level. Its
 * folders are rows its space owns at such a path; they nest at most
 * TREE_MAX_DEPTH deep like every folder. It changes only its own rows: a brain
 * folder, or a teammate's draft, is never its to rename or move.
 *
 * The checks read the member's view on the admin pool (./member-tree); the
 * writes run on the admin pool too, always narrowed to the member's own space
 * (owner_id = its space id, from the session). A draft submitted for review
 * (frozen) never moves: not on its own, and not with its folder. A folder
 * that holds one is not renamed, moved or deleted until the review is done,
 * so the place the admin reviewed is the place Accept uses.
 */
import { sql } from 'drizzle-orm';
import { db, takeShareWriteLock, takeShareReadLock } from '@mantle/db';
import { dashToLtree, folderSlugOf } from '@mantle/files';
import type { AppTint } from '@mantle/client-types/app-nav';
import {
  TREE_FOLDER_NAME_MAX,
  TREE_KIND_SPECS,
  TREE_MAX_DEPTH,
  type TreeFolder,
  type TreeKind,
} from '@mantle/client-types/tree';
import { treeParentPath } from '@mantle/content-core/tree';
import { READER_TREE_KINDS } from './kinds';
import { memberView, storedPathOf, type MemberTreeScope, type MemberView } from './member-tree';
import { TreeError, type TreeMoveResult } from './write';

function assertKind(kind: TreeKind): void {
  if (!READER_TREE_KINDS.includes(kind)) {
    throw new TreeError('invalid', `the ${kind} tree has no member folders`);
  }
}

function cleanName(name: string): string {
  const clean = name.trim().replace(/\s+/g, ' ').slice(0, TREE_FOLDER_NAME_MAX);
  if (!clean) throw new TreeError('invalid', 'a folder needs a name');
  return clean;
}

function labelOf(name: string): { slug: string; label: string } {
  const slug = folderSlugOf(name);
  if (!slug) throw new TreeError('invalid', `'${name}' has no letters or digits to name it by`);
  return { slug, label: dashToLtree(slug) };
}

const depthOf = (path: string) => path.split('.').length - 1;

/** How many folders of one kind a member may keep. Branch rows do not count
 *  toward the space's item limit, and every tree read builds all of them. */
export const MEMBER_FOLDERS_MAX = 500;

/** The tree path of a place the member may file into: a folder its tree
 *  shows, or the top level (null). */
function placeOf(view: MemberView, folderId: string | null): string {
  if (folderId === null) return TREE_KIND_SPECS[view.kind].root;
  const f = view.byId.get(folderId);
  if (!f) throw new TreeError('not-found', 'folder not found');
  return f.path;
}

/** The tree path where a new draft of `kind` goes: validated for the member,
 *  stored form (a member's files mirror under space_files). Null = the top
 *  level as the kind stores it. */
export async function memberFilingPath(
  scope: MemberTreeScope,
  kind: TreeKind,
  folderId: string | null,
): Promise<string> {
  assertKind(kind);
  const view = await memberView(scope, kind);
  return storedPathOf(kind, placeOf(view, folderId));
}

async function reload(scope: MemberTreeScope, kind: TreeKind, id: string): Promise<TreeFolder> {
  const f = (await memberView(scope, kind)).ownById.get(id);
  if (!f) throw new Error('member folder: the folder is not readable after the write');
  return f;
}

/** Create one of the member's own folders under `parentId` (null = the top
 *  level). Refused where the member's tree already shows a folder of that
 *  name. */
export async function createMemberFolder(
  scope: MemberTreeScope,
  kind: TreeKind,
  args: { parentId: string | null; name: string },
): Promise<TreeFolder> {
  assertKind(kind);
  const view = await memberView(scope, kind);
  const parent = placeOf(view, args.parentId);
  const title = cleanName(args.name);
  const { slug, label } = labelOf(title);
  const path = `${parent}.${label}`;
  if (depthOf(path) > TREE_MAX_DEPTH) {
    throw new TreeError('invalid', `folders nest at most ${TREE_MAX_DEPTH} deep`);
  }
  if (view.byPath.has(path)) {
    throw new TreeError('conflict', `a folder named '${title}' already exists here`);
  }
  const [{ n } = { n: 0 }] = (await db.execute(sql`
    select count(*)::int as n from nodes
     where owner_id = ${scope.spaceId} and type = 'branch'
       and path <@ ${storedPathOf(kind, TREE_KIND_SPECS[kind].root)}::ltree
       and nlevel(path) > 1`)) as unknown as Array<{ n: number }>;
  if (n >= MEMBER_FOLDERS_MAX) {
    throw new TreeError(
      'invalid',
      `you keep ${MEMBER_FOLDERS_MAX} folders here already; delete some before making more`,
    );
  }
  const [row] = (await db.execute(sql`
    insert into nodes (owner_id, type, title, slug, path, audience, data, tags)
    values (${scope.spaceId}, 'branch', ${title}, ${slug}, ${storedPathOf(kind, path)}::ltree,
            'admin', '{}'::jsonb, '{}')
    on conflict do nothing
    returning id`)) as unknown as { id: string }[];
  if (!row) throw new TreeError('conflict', `a folder named '${title}' already exists here`);
  return reload(scope, kind, row.id);
}

export type MemberFolderPatch = {
  name?: string;
  icon?: string | null;
  color?: AppTint | null;
  /** Move under another folder the member sees; null = the top level. */
  parentId?: string | null;
};

/** Rewrite the member's own rows under `from` to sit under `to` (stored
 *  paths). Its folders whose new path it already has merge into them. */
async function rewriteOwn(
  tx: Pick<typeof db, 'execute'>,
  spaceId: string,
  from: string,
  to: string,
  opts: { keepSelf?: boolean } = {},
): Promise<void> {
  const mapped = sql`case when n.path = ${from}::ltree then text2ltree(${to})
                          else (text2ltree(${to}) || subpath(n.path, nlevel(${from}::ltree)))::ltree end`;
  const own = sql`n.owner_id = ${spaceId} and n.path <@ ${from}::ltree`;
  await tx.execute(sql`
    delete from nodes n
     where ${own} and n.type = 'branch'
       and (${!opts.keepSelf} and n.path = ${from}::ltree
            or exists (select 1 from nodes b
                        where b.owner_id = n.owner_id and b.type = 'branch'
                          and b.path = ${mapped} and not (b.path <@ ${from}::ltree)))`);
  await tx.execute(sql`update nodes n set path = ${mapped} where ${own}`);
}

/** Refuse to move a folder (rename, move, delete) while it holds a draft
 *  that is with an admin: the admin's Accept lands it where it sits. */
async function refuseFrozenInside(
  tx: Pick<typeof db, 'execute'>,
  spaceId: string,
  stored: string,
  name: string,
): Promise<void> {
  const [hit] = (await tx.execute(sql`
    select 1 from nodes
     where owner_id = ${spaceId} and path <@ ${stored}::ltree and type <> 'branch'
       and mantle_space_item_frozen(id)
     limit 1`)) as unknown as unknown[];
  if (hit) {
    throw new TreeError(
      'conflict',
      `'${name}' holds a draft that is with an admin for review; it stays where it is until the review is done`,
    );
  }
}

/** Change one of the member's own folders: move, then rename, then look. */
export async function updateMemberFolder(
  scope: MemberTreeScope,
  kind: TreeKind,
  folderId: string,
  patch: MemberFolderPatch,
): Promise<TreeFolder> {
  assertKind(kind);
  const view = await memberView(scope, kind);
  const folder = view.ownById.get(folderId);
  if (!folder) {
    throw new TreeError(
      'not-found',
      view.byId.has(folderId) ? 'only your own folders can be changed' : 'folder not found',
    );
  }
  const parent =
    patch.parentId !== undefined ? placeOf(view, patch.parentId) : treeParentPath(folder.path);
  if (parent === folder.path || parent.startsWith(`${folder.path}.`)) {
    throw new TreeError('invalid', 'a folder cannot move inside itself');
  }
  const title = patch.name !== undefined ? cleanName(patch.name) : null;
  const naming = title ? labelOf(title) : null;
  const label = naming?.label ?? folder.path.split('.').at(-1)!;
  const path = `${parent}.${label}`;
  if (path !== folder.path) {
    let levels = 1;
    for (const f of view.ownById.values()) {
      if (f.path.startsWith(`${folder.path}.`)) {
        levels = Math.max(levels, depthOf(f.path) - depthOf(folder.path) + 1);
      }
    }
    if (depthOf(parent) + levels > TREE_MAX_DEPTH) {
      throw new TreeError(
        'invalid',
        `'${folder.name}' and its folders would nest deeper than ${TREE_MAX_DEPTH} levels there`,
      );
    }
    if (view.byPath.has(path)) {
      throw new TreeError(
        'conflict',
        `a folder named '${title ?? folder.name}' already exists there`,
      );
    }
  }
  await db.transaction(async (tx) => {
    if (path !== folder.path) {
      await takeShareWriteLock(tx, scope.spaceId);
      await refuseFrozenInside(tx, scope.spaceId, storedPathOf(kind, folder.path), folder.name);
      await rewriteOwn(
        tx,
        scope.spaceId,
        storedPathOf(kind, folder.path),
        storedPathOf(kind, path),
        { keepSelf: true },
      );
    }
    const look: Record<string, unknown> = {};
    if (patch.icon !== undefined) look.icon = patch.icon;
    if (patch.color !== undefined) look.color = patch.color;
    await tx.execute(sql`
      update nodes set
        title = coalesce(${title}, title),
        slug = coalesce(${naming?.slug ?? null}, slug),
        data = jsonb_strip_nulls(coalesce(data, '{}'::jsonb) || ${JSON.stringify(look)}::jsonb),
        updated_at = now()
       where id = ${folderId} and owner_id = ${scope.spaceId} and type = 'branch'`);
  });
  return reload(scope, kind, folderId);
}

/** Delete one of the member's own folders; what it holds of the member's
 *  moves up to its parent (merging with folders of the same name there). */
export async function deleteMemberFolder(
  scope: MemberTreeScope,
  kind: TreeKind,
  folderId: string,
): Promise<void> {
  assertKind(kind);
  const view = await memberView(scope, kind);
  const folder = view.ownById.get(folderId);
  if (!folder) {
    throw new TreeError(
      'not-found',
      view.byId.has(folderId) ? 'only your own folders can be deleted' : 'folder not found',
    );
  }
  await db.transaction(async (tx) => {
    await takeShareWriteLock(tx, scope.spaceId);
    await refuseFrozenInside(tx, scope.spaceId, storedPathOf(kind, folder.path), folder.name);
    await rewriteOwn(
      tx,
      scope.spaceId,
      storedPathOf(kind, folder.path),
      storedPathOf(kind, treeParentPath(folder.path)),
    );
  });
}

/**
 * File the member's own drafts into a folder its tree shows (null = the top
 * level). Each moves on its own: one that is not the member's, is another
 * kind, or is with an admin for review is reported, the rest still move.
 */
export async function moveMemberItems(
  scope: MemberTreeScope,
  kind: TreeKind,
  itemIds: readonly string[],
  folderId: string | null,
): Promise<TreeMoveResult> {
  assertKind(kind);
  const view = await memberView(scope, kind);
  const dest = storedPathOf(kind, placeOf(view, folderId));
  const result: TreeMoveResult = { moved: 0, failed: [] };
  for (const id of new Set(itemIds)) {
    try {
      // The space's share lock (shared) before the row: takeShareReadLock.
      const rows = await db.transaction(async (tx) => {
        await takeShareReadLock(tx, scope.spaceId);
        return (await tx.execute(sql`
          update nodes set path = ${dest}::ltree
           where id = ${id} and owner_id = ${scope.spaceId}
             and type = ${TREE_KIND_SPECS[kind].nodeType}
             and not mantle_space_item_frozen(id)
          returning id`)) as unknown as unknown[];
      });
      if (rows.length) result.moved += 1;
      else result.failed.push({ id, error: 'not one of your drafts that can move now' });
    } catch (err) {
      result.failed.push({ id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
