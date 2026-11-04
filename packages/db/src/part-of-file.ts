/**
 * A part of a file: an import table or an image the extract worker makes from
 * it (docs/workspaces.md, "Parts of a file"). It takes the file's home and
 * grants, once, when it is made. After that it is an ordinary item.
 */
import { sql } from 'drizzle-orm';
import { db } from './gateway/handles';
import { withHeads } from './gateway/heads';
import { withCreateHome } from './viewer';

/** The file is gone, or its home is: no part, as it must never fall to Admin. */
export class PartHasNoHomeError extends Error {
  constructor() {
    super('a part of a file needs the live home of that file');
  }
}

/** Give `part` the file's rows: its home, and each grant with its Write. A
 *  row the file does not hold (one a folder passes) is "Removed here". */
export function copyFileRows(partId: string, fileId: string): Promise<void> {
  return withHeads([partId], 'update', async (tx) => {
    await tx.execute(sql`delete from item_grants p using item_grants f
      where p.node_id = ${partId} and p.is_home and f.node_id = ${fileId} and f.is_home
        and p.workspace_id <> f.workspace_id`);
    await tx.execute(sql`insert into item_grants (node_id, workspace_id, write, is_home)
      select ${partId}::uuid, f.workspace_id, f.write, f.is_home from item_grants f
       where f.node_id = ${fileId} and not f.excluded
      on conflict (node_id, workspace_id) do update
        set write = excluded.write, is_home = excluded.is_home, via_folder_id = null`);
    await tx.execute(sql`update item_grants p set excluded = true, write = false, via_folder_id = null
      where p.node_id = ${partId} and not p.is_home and not exists (
        select 1 from item_grants f where f.node_id = ${fileId}
           and f.workspace_id = p.workspace_id and not f.excluded)`);
  });
}

/** Make a part of `fileId`: `create` runs with the file's home as its create
 *  home, then the part takes the file's rows. */
export async function createPartOfFile<T extends { id: string }>(
  fileId: string,
  create: () => Promise<T>,
): Promise<T> {
  const [file] = (await db.execute(sql`select w.id::text as home from nodes n
    join workspaces w on w.id = n.home_ws and w.archived_at is null
    where n.id = ${fileId} and n.type = 'file'`)) as unknown as { home: string }[];
  if (!file) throw new PartHasNoHomeError();
  const part = await withCreateHome({ createWs: file.home, privateWs: null }, create);
  await copyFileRows(part.id, fileId);
  return part;
}
