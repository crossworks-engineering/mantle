/**
 * A part of a file: an import table or an image the extract worker makes from
 * it (docs/workspaces.md, "Parts of a file"). It takes the file's home and
 * grants, once, when it is made. After that it is an ordinary item.
 */
import { and, eq, ne, notInArray, sql } from 'drizzle-orm';
import { db } from './gateway/handles';
import { withHeads } from './gateway/heads';
import { itemGrants } from './schema/index';
import { withCreateHome } from './viewer';
import { liveWorkspaceSql } from './workspace-live';

/** The file is gone, or its home is: no part, as it must never fall to Admin. */
export class PartHasNoHomeError extends Error {
  constructor() {
    super('a part of a file needs the live home of that file');
  }
}

/** Give `part` the file's rows: its home, and each grant with its Write. A
 *  row the file does not hold (one a folder passes) is "Removed here". */
export function copyFileRows(partId: string, fileId: string): Promise<void> {
  const g = itemGrants;
  return withHeads([partId], 'update', async (tx) => {
    const held = await tx
      .select({ workspaceId: g.workspaceId, write: g.write, isHome: g.isHome })
      .from(g)
      .where(and(eq(g.nodeId, fileId), eq(g.excluded, false)));
    const home = held.find((r) => r.isHome)?.workspaceId;
    if (!home) return;
    await tx
      .delete(g)
      .where(and(eq(g.nodeId, partId), eq(g.isHome, true), ne(g.workspaceId, home)));
    await tx
      .insert(g)
      .values(held.map((r) => ({ ...r, nodeId: partId })))
      .onConflictDoUpdate({
        target: [g.nodeId, g.workspaceId],
        set: { write: sql`excluded.write`, isHome: sql`excluded.is_home`, viaFolderId: null },
      });
    await tx
      .update(g)
      .set({ excluded: true, write: false, viaFolderId: null })
      .where(
        and(
          eq(g.nodeId, partId),
          eq(g.isHome, false),
          notInArray(
            g.workspaceId,
            held.map((r) => r.workspaceId),
          ),
        ),
      );
  });
}

/** Make a part of `fileId`: `create` runs with the file's home as its create
 *  home, then the part takes the file's rows. */
export async function createPartOfFile<T extends { id: string }>(
  fileId: string,
  create: () => Promise<T>,
): Promise<T> {
  const [file] = (await db.execute(sql`select w.id::text as home from nodes n
    join workspaces w on w.id = n.home_ws and ${liveWorkspaceSql('w')}
    where n.id = ${fileId} and n.type = 'file'`)) as unknown as { home: string }[];
  if (!file) throw new PartHasNoHomeError();
  const part = await withCreateHome({ createWs: file.home, privateWs: null }, create);
  await copyFileRows(part.id, fileId);
  return part;
}
