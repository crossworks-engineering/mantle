/**
 * Whether a team app's move would change who reads a file (@mantle/tools
 * member-app-tools.ts rule 7): a team app writes as its runner, but never
 * confirms a change of who can see an existing item. The visibility guard
 * asked first, in the runner's scope (it names what the runner sees); this
 * asks again where the move runs (@mantle/files moveFileById, inside its
 * transaction with the file and both folders held), against every grant,
 * so a workspace the runner's scope does not see is counted too.
 */
import { sql } from 'drizzle-orm';
import { UUID_RE } from '@mantle/std';
import { getAdminDb } from './gateway/pools';

/**
 * Whether placing the file `fileId` in the folder at `destPath` would make a
 * workspace start or stop reading it, as the move triggers derive grants
 * (0244, @mantle/content tree/visibility.ts placedRows): the folder's rows
 * the file may take that it does not hold now (and has no exclusion for),
 * or a folder-derived row of the file the folder does not give. A missing
 * file, an id that is not a uuid or a path that is no ltree answers true
 * (refused). Admin pool: every grant, whatever the caller's scope.
 */
export async function appRunMoveChangesReaders(fileId: string, destPath: string): Promise<boolean> {
  const id = fileId.trim().toLowerCase();
  if (!UUID_RE.test(id) || typeof destPath !== 'string' || destPath.length > 500) return true;
  const rows = (await getAdminDb().execute(sql`
    with f as (
      select n.id, n.owner_id, n.type, n.read_ws from nodes n
       where n.id = ${id}::uuid and n.type = 'file' and pg_input_is_valid(${destPath}, 'ltree')),
    passes as (
      select g.workspace_id as x
        from f, item_grants g
       where g.node_id = mantle_parent_folder(f.owner_id, f.type, ${destPath}::ltree)
         and not g.excluded
         and mantle_grant_kind_ok(f.type, g.workspace_id, true))
    select
      exists (
        select 1 from passes p, f
         where not (p.x = any(coalesce(f.read_ws, '{}'::uuid[])))
           and not exists (select 1 from item_grants e
                            where e.node_id = f.id and e.workspace_id = p.x and e.excluded))
      or exists (
        select 1 from f, item_grants g
         where g.node_id = f.id and g.via_folder_id is not null
           and not g.is_home and not g.excluded
           and not exists (select 1 from passes p where p.x = g.workspace_id)) as changes,
      exists (select 1 from f) as found`)) as unknown as { changes: boolean; found: boolean }[];
  const row = rows[0];
  return !row?.found || row.changes;
}
