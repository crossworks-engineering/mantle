/**
 * A part of a file: an import table or an image the extract worker makes from
 * it (docs/workspaces.md, "Parts of a file"). It takes the file's home and
 * grants, once, when it is made. After that it is an ordinary item.
 */
import { and, eq, ne, notInArray, sql } from 'drizzle-orm';
import { db } from './gateway/handles';
import { withDeadlockRetry, withHeads } from './gateway/heads';
import { itemGrants, nodes } from './schema/index';
import { withCreateHome } from './viewer';
import { liveWorkspaceSql } from './workspace-live';

/** The file is gone, or its home is: no part, as it must never fall to Admin. */
export class PartHasNoHomeError extends Error {
  constructor() {
    super('a part of a file needs the live home of that file');
  }
}

/** Give `part` the file's rows: its home, each grant with its Write, and the
 *  login it is private to. A row the file does not hold (one a folder passes)
 *  is "Removed here". False when `onlyIf`, asked under the part's head, says
 *  no. Refused when the file has no home left. */
export function copyFileRows(
  partId: string,
  fileId: string,
  onlyIf?: (tx: Parameters<Parameters<typeof withHeads>[2]>[0]) => Promise<boolean>,
): Promise<boolean> {
  const g = itemGrants;
  return withDeadlockRetry(() =>
    withHeads([partId], 'update', async (tx) => {
      if (onlyIf && !(await onlyIf(tx))) return false;
      const [file] = await tx
        .select({ loginId: nodes.loginId })
        .from(nodes)
        .where(eq(nodes.id, fileId));
      const held = await tx
        .select({ workspaceId: g.workspaceId, write: g.write, isHome: g.isHome })
        .from(g)
        .where(and(eq(g.nodeId, fileId), eq(g.excluded, false)));
      const home = held.find((r) => r.isHome)?.workspaceId;
      if (!file || !home) throw new PartHasNoHomeError();
      if (file.loginId) {
        await tx.update(nodes).set({ loginId: file.loginId }).where(eq(nodes.id, partId));
      }
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
      return true;
    }),
  );
}

/** Make a part of `fileId`: `create` runs with the file's home as its create
 *  home, then the part takes the file's rows. If that fails, `remove` takes the
 *  part away again: it must not stay with the rows it was made with. */
export async function createPartOfFile<T extends { id: string }>(
  fileId: string,
  create: () => Promise<T>,
  remove: (part: T) => Promise<unknown>,
): Promise<T> {
  const [file] = (await db.execute(sql`select w.id::text as home from nodes n
    join workspaces w on w.id = n.home_ws and ${liveWorkspaceSql('w')}
    where n.id = ${fileId} and n.type = 'file'`)) as unknown as { home: string }[];
  if (!file) throw new PartHasNoHomeError();
  const part = await withCreateHome({ createWs: file.home, privateWs: null }, create);
  try {
    await copyFileRows(part.id, fileId);
  } catch (err) {
    await remove(part);
    throw err;
  }
  return part;
}
