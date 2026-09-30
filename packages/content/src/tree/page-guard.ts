/**
 * The visibility confirm for a NEW page (folder phase 7; folder plan
 * section 4, "Confirm before visibility changes"). A page made in a shared
 * folder is read at the folder's share from its first moment, and what its
 * document embeds opens with it (migration 0208: the insert's own edges
 * raise `embedded_level` on the refs). Notes cannot be created in a folder
 * (they file through the guarded move) and a new file goes through
 * `guardNewFileIn`; this is the same guard for a page, with the embeds
 * listed too (`alsoEmbeds`), so an agent's `page_create` into a
 * client-shared folder with a private picture in its markdown is refused
 * with the list until the user agrees.
 */
import { sql } from 'drizzle-orm';
import { db } from '@mantle/db';
import {
  TREE_KIND_SPECS,
  TREE_VISIBILITY_LIST_MAX,
  type TreeShareLevel,
  type TreeVisibilityChange,
} from '@mantle/client-types/tree';
import { effectiveLevel } from '@mantle/content-core/tree';
import type { AccessLevel } from '@mantle/client-types';
import { referencedEmbedIds } from '../doc-assets';
import { NO_CHANGE, TreeVisibilityError, changeCount, type VisibilityDiff } from './visibility';
import type { ConfirmOpts } from './files-guard';

type Via = Pick<typeof db, 'execute'>;

/**
 * What a new page at `destPath` holding `doc` would change: the page itself
 * (admin, read at the folder's share) and, transitively, what the doc
 * embeds that would be read more openly through it. Dry: nothing is written.
 */
export async function newPageDiff(
  via: Via,
  ownerId: string,
  destPath: string,
  title: string,
  doc: unknown,
): Promise<VisibilityDiff> {
  const [row] = (await via.execute(sql`
    select mantle_inherited_level(${ownerId}::uuid, ${destPath}::ltree,
                                  ${TREE_KIND_SPECS.pages.nodeType}::node_type) as share`)) as unknown as Array<{
    share: TreeShareLevel | null;
  }>;
  const share = row?.share ?? null;
  const from: AccessLevel = 'admin';
  const to = effectiveLevel(from, share);
  if (to === from || !share) return NO_CHANGE;
  const diff: VisibilityDiff = { changes: [{ id: '', title, from, to }], total: 1 };

  const refs = referencedEmbedIds(doc);
  if (!refs.length) return diff;
  // The refs and everything they reach through embeds, each at the level it
  // is read at now against the level it would be read at with the new page
  // sharing it (the most open of its own, its inherited and its embedded
  // level, the new share among them); listed where that differs.
  const eff = (embedded: string) =>
    sql.raw(`(case
      when 'client' in (n.inherited_level, ${embedded}) and n.audience in ('admin', 'team') then 'client'
      when 'team' in (n.inherited_level, ${embedded}) and n.audience = 'admin' then 'team'
      else n.audience end)`);
  const found = (await via.execute(sql`
    with recursive down(id) as (
      select x::uuid from unnest(${sql.raw(`array[${refs.map((r) => `'${r.replace(/'/g, "''")}'`).join(', ')}]`)}::text[]) x
      union
      select e.to_id from node_embeds e
        join down on e.from_id = down.id
        join nodes x on x.id = down.id and x.owner_id = ${ownerId}
    )
    select r.id::text as id, r.title, r."from", r."to", r.type,
           count(*) over () as total from (
      select n.id, n.title, n.type::text as type,
             ${eff('n.embedded_level')} as "from",
             ${eff(`(case when 'client' in (n.embedded_level, '${share}') then 'client'
                          when 'team' in (n.embedded_level, '${share}') then 'team'
                          else n.embedded_level end)`)} as "to"
        from nodes n join down on n.id = down.id
       where n.owner_id = ${ownerId} and mantle_workspace_kind(n.type)) r
     where r."from" is distinct from r."to"
     order by lower(r.title), r.id
     limit ${TREE_VISIBILITY_LIST_MAX}`)) as unknown as Array<
    TreeVisibilityChange & { total: number | string }
  >;
  if (!found.length) return diff;
  return {
    ...diff,
    alsoEmbeds: found.map(({ total: _total, ...c }) => c),
    embedsTotal: Number(found[0]!.total),
  };
}

/** A NEW page in the folder at `destPath`: refused with the list unless
 *  confirmed; with `seen`, refused again when the change differs now. */
export async function guardNewPageIn(
  via: Via,
  ownerId: string,
  destPath: string,
  title: string,
  doc: unknown,
  opts: ConfirmOpts,
): Promise<VisibilityDiff> {
  const diff = await newPageDiff(via, ownerId, destPath, title, doc);
  const count = changeCount(diff);
  if (count > 0 && !opts.confirm) throw new TreeVisibilityError(diff);
  if (opts.confirm && opts.seen !== undefined && count > 0 && count !== opts.seen) {
    throw new TreeVisibilityError(diff);
  }
  return diff;
}
