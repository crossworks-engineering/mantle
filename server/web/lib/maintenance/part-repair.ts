/**
 * Give old import tables and extracted images their file's home and grants,
 * by the worker's own step (@mantle/db copyFileRows). Before this they landed
 * in Admin (docs/workspaces.md, "Parts of a file").
 *
 * Worker-made, told from a user's copy: a table with the tag `auto-import`, a
 * file with the tag `extracted-image` and `data.sourceOrdinal`. Only the
 * worker's passes set these. A user who typed `auto-import` on table_from_file
 * looks the same; the tool sets no tag of its own. A video's audio has neither.
 *
 * It changes an item only with the untouched Admin default: homed in Admin, no
 * person's name on that row, and no other row but a folder's. It leaves and
 * counts the rest. Manual, dry run by default, never deletes, no model call,
 * ids and counts only.
 */
import { copyFileRows, db, sql } from '@mantle/db';

export const PART_REPAIR_DEFAULT_LIMIT = 100;
export const PART_REPAIR_MAX_LIMIT = 1000;

export type OldPart = { id: string; type: string; fileId: string; ready: boolean; gone: boolean };

const OLD_PARTS = sql`
    select n.id::text as id, n.type::text as type, n.data->>'sourceFileId' as file_id,
           f.id is null as gone,
           f.id is not null and h.granted_by is null and h.workspace_id = a.id
             and not exists (select 1 from item_grants o where o.node_id = n.id and not o.is_home
                              and o.via_folder_id is null) as ready
      from nodes n
      join workspaces a on a.owner_id = n.owner_id and a.is_admin and a.archived_at is null
      left join item_grants h on h.node_id = n.id and h.is_home
      left join nodes f on f.id::text = n.data->>'sourceFileId' and f.type = 'file'
     where (n.type = 'table' and 'auto-import' = any(n.tags) and n.data ? 'sourceFileId')
        or (n.type = 'file' and 'extracted-image' = any(n.tags) and n.data ? 'sourceFileId'
            and n.data ? 'sourceOrdinal')`;

/** The old worker-made items. An item it changed reads as left from then on. */
export async function findOldParts(): Promise<OldPart[]> {
  const rows = (await db.execute(sql`${OLD_PARTS} order by n.created_at, n.id`)) as unknown as {
    id: string;
    type: string;
    file_id: string;
    ready: boolean;
    gone: boolean;
  }[];
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    fileId: r.file_id,
    ready: r.ready,
    gone: r.gone,
  }));
}

/** Give one item its file's rows. */
export function repairOldPart(part: OldPart): Promise<void> {
  return copyFileRows(part.id, part.fileId);
}
