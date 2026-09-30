/**
 * Where an accepted draft lands (folder plan phase 5, "Accept claims in
 * place").
 *
 * A member files a draft in the brain's tree: its path is a brain folder's
 * path, maybe with the member's own private folders below it
 * (`notes.clients.acme.mine`: Clients and Acme are the brain's, Mine is the
 * member's). By default Accept keeps it there: the base is the deepest BRAIN
 * folder on its path (Acme), and the member's own chain below (Mine) becomes
 * brain folders under the base, merging by name with brain folders already
 * there. The admin may pick another brain folder as the base; the member's
 * chain still goes below the pick. Either way the result nests at most
 * TREE_MAX_DEPTH folders deep (the chain is cut to fit).
 *
 * Pages have no tree yet (phase 7): they keep their own Accept placement.
 * Files: a member's file paths mirror the brain's under `space_files`
 * (spaceFilesPath, @mantle/db); the brain's are `files...`.
 */
import { sql } from 'drizzle-orm';
import { db, spaceFilesPath } from '@mantle/db';
import {
  TREE_KIND_SPECS,
  TREE_MAX_DEPTH,
  type TreeCrumb,
  type TreeKind,
  type TreeShareLevel,
} from '@mantle/client-types/tree';
import { treeFolderChain } from '@mantle/content-core/tree';
import { treePathOf } from './tree/member-tree';

type Via = Pick<typeof db, 'execute'>;

/** The tree kind of a member item type; null for a page (no tree yet). */
export function treeKindOfType(type: string): TreeKind | null {
  switch (type) {
    case 'note':
      return 'notes';
    case 'draw':
      return 'draw';
    case 'table':
      return 'tables';
    case 'file':
      return 'files';
    default:
      return null;
  }
}

/** A folder an Accept makes (or finds) below the base: a brain path and the
 *  name and look the member gave its own folder there. */
type ChainFolder = { path: string; label: string; title: string; data: Record<string, unknown> };

export type PlacePlan = {
  kind: TreeKind;
  /** The brain folder the item goes in or under: null = the kind's root. */
  base: { id: string | null; path: string };
  /** The member's chain below the base, cut to fit TREE_MAX_DEPTH. */
  chain: ChainFolder[];
  /** Where the item lands (the base, or the last of the chain). */
  target: string;
};

/**
 * Plan where an item lands. `pick`: undefined keeps it in place; null is
 * the kind's root; an id is a brain folder of the item's kind (anything else
 * is refused with null). Read only.
 */
export async function planPlace(
  via: Via,
  brainId: string,
  spaceId: string,
  item: { type: string; path: string },
  pick?: string | null,
): Promise<PlacePlan | null> {
  const kind = treeKindOfType(item.type);
  if (!kind) return null;
  const root = TREE_KIND_SPECS[kind].root;
  const p = treePathOf(kind, item.path);
  const chain = p === root || p.startsWith(`${root}.`) ? treeFolderChain(p) : [];
  // The brain folders on the item's own path, deepest last.
  const onPath = chain.length
    ? ((await via.execute(sql`
        select id, path::text as path from nodes
         where owner_id = ${brainId} and type = 'branch'
           and path::text in (${sql.join(
             chain.map((c) => sql`${c}`),
             sql`, `,
           )})
         order by nlevel(path)`)) as unknown as Array<{ id: string; path: string }>)
    : [];
  // The deepest brain folder whose whole chain is the brain's (a gap means
  // the member's own folder sits there).
  let inPlace: { id: string | null; path: string } = { id: null, path: root };
  for (const c of chain) {
    const hit = onPath.find((r) => r.path === c);
    if (!hit) break;
    inPlace = { id: hit.id, path: hit.path };
  }
  const tail = chain.slice(inPlace.path === root ? 0 : treeFolderChain(inPlace.path).length);

  let base = inPlace;
  if (pick !== undefined) {
    if (pick === null) base = { id: null, path: root };
    else {
      const [f] = (await via.execute(sql`
        select id, path::text as path from nodes
         where id = ${pick} and owner_id = ${brainId} and type = 'branch'
           and path <@ ${root}::ltree and nlevel(path) > 1`)) as unknown as Array<{
        id: string;
        path: string;
      }>;
      if (!f) return null;
      base = { id: f.id, path: f.path };
    }
  }

  // The member's own folders on the tail: their names and looks.
  const own = tail.length
    ? ((await via.execute(sql`
        select path::text as path, title, data from nodes
         where owner_id = ${spaceId} and type = 'branch'
           and path::text in (${sql.join(
             tail.map((t) => sql`${kind === 'files' ? spaceFilesPath(t) : t}`),
             sql`, `,
           )})`)) as unknown as Array<{
        path: string;
        title: string;
        data: Record<string, unknown> | null;
      }>)
    : [];
  const ownAt = new Map(own.map((o) => [treePathOf(kind, o.path), o]));
  const room = TREE_MAX_DEPTH - (base.path.split('.').length - 1);
  const folders: ChainFolder[] = [];
  let at = base.path;
  for (const t of tail.slice(0, Math.max(0, room))) {
    const label = t.split('.').at(-1)!;
    at = `${at}.${label}`;
    const o = ownAt.get(t);
    const look: Record<string, unknown> = {};
    if (o?.data?.icon) look.icon = o.data.icon;
    if (o?.data?.color) look.color = o.data.color;
    folders.push({ path: at, label, title: o?.title ?? label, data: look });
  }
  return { kind, base, chain: folders, target: at };
}

/** Make the plan's chain real: brain folders at each path, kept when one is
 *  already there (merged by name). Files folders get their directory when
 *  the file lands (the Accept copies with `mkdir -p`). */
export async function ensurePlaced(tx: Via, brainId: string, plan: PlacePlan): Promise<void> {
  for (const f of plan.chain) {
    await tx.execute(sql`
      insert into nodes (owner_id, type, title, slug, path, data, tags)
      values (${brainId}, 'branch', ${f.title}, ${f.label.replace(/_/g, '-')}, ${f.path}::ltree,
              ${JSON.stringify(f.data)}::jsonb, '{}')
      on conflict (owner_id, path) where type = 'branch' do nothing`);
  }
}

/** Remove the member's own folders on `paths` (stored) that hold nothing of
 *  the member's any more: after an Accept took what was in them. */
export async function dropEmptyOwnFolders(
  tx: Via,
  spaceId: string,
  paths: readonly string[],
): Promise<void> {
  const wanted = [...new Set(paths.flatMap((p) => treeFolderChain(p)))];
  if (!wanted.length) return;
  // Deepest first: a parent is empty only once its child has gone.
  for (let i = 0; i < TREE_MAX_DEPTH; i++) {
    await tx.execute(sql`
      delete from nodes n
       where n.owner_id = ${spaceId} and n.type = 'branch'
         and n.path::text in (${sql.join(
           wanted.map((w) => sql`${w}`),
           sql`, `,
         )})
         and not exists (select 1 from nodes c
                          where c.owner_id = n.owner_id and c.id <> n.id
                            and c.path <@ n.path)`);
  }
}

/**
 * The share each item would inherit where it lands in the brain (migration
 * 0204's rule, mantle_inherited_level): the nearest shared brain folder at or
 * above its landing path. The chain folders an Accept makes are never shared,
 * so the answer holds before they exist. Read only.
 */
export async function sharesAt(
  via: Via,
  brainId: string,
  landings: ReadonlyArray<{ id: string; path: string; type: string }>,
): Promise<Map<string, TreeShareLevel | null>> {
  if (!landings.length) return new Map();
  const rows = (await via.execute(sql`
    select x.id, mantle_inherited_level(${brainId}::uuid, x.p::ltree, x.t::node_type) as share
      from (values ${sql.join(
        landings.map((l) => sql`(${l.id}, ${l.path}, ${l.type})`),
        sql`, `,
      )}) as x(id, p, t)`)) as unknown as Array<{ id: string; share: TreeShareLevel | null }>;
  return new Map(rows.map((r) => [r.id, r.share ?? null]));
}

/** What the accept dialog shows: where the item goes by default. */
export type AcceptPlace = {
  kind: TreeKind;
  /** The brain folder it goes in or under by default; null = the root. */
  folderId: string | null;
  /** That folder's crumbs, top-down, itself included. */
  crumbs: TreeCrumb[];
  /** The member's own folders that become brain folders below it. */
  creates: string[];
  /** The share it is read at there through a shared folder (null: none). The
   *  item is read at the more open of this and its chosen level. */
  share: TreeShareLevel | null;
};

/** Where an Accept puts the item: in place (`pick` undefined), the top
 *  level (null) or a brain folder of its kind. Null when it has no tree (a
 *  page) or the pick is not such a folder. */
export async function acceptPlace(
  via: Via,
  brainId: string,
  spaceId: string,
  item: { id: string; type: string; path: string },
  pick?: string | null,
): Promise<AcceptPlace | null> {
  const plan = await planPlace(via, brainId, spaceId, item, pick);
  if (!plan) return null;
  const shares = await sharesAt(via, brainId, [
    { id: item.id, path: plan.target, type: item.type },
  ]);
  const chain = plan.base.id ? treeFolderChain(plan.base.path) : [];
  const rows = chain.length
    ? ((await via.execute(sql`
        select id, path::text as path, title from nodes
         where owner_id = ${brainId} and type = 'branch'
           and path::text in (${sql.join(
             chain.map((c) => sql`${c}`),
             sql`, `,
           )})`)) as unknown as Array<{ id: string; path: string; title: string }>)
    : [];
  const byPath = new Map(rows.map((r) => [r.path, r]));
  return {
    kind: plan.kind,
    folderId: plan.base.id,
    crumbs: chain.flatMap((c) => {
      const r = byPath.get(c);
      return r ? [{ id: r.id, name: r.title }] : [];
    }),
    creates: plan.chain.map((f) => f.title),
    share: shares.get(item.id) ?? null,
  };
}
