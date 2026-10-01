import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { TREE_FOLDER_NAME_MAX } from '@mantle/client-types/tree';
import { createTreeFolder, notifyTreeChanged } from '@mantle/content/tree';
import { firstIssue } from '@/lib/zod-issue';
import {
  FolderColorBody,
  FolderIconBody,
  ensureTreeRoot,
  treeErrorResponse,
  treeKindOr404,
} from '@/lib/tree-route';

const Body = z.object({
  /** The folder to create it in; null = the top level. */
  parentId: z.string().uuid().nullable(),
  name: z.string().trim().min(1).max(TREE_FOLDER_NAME_MAX),
  /** Its look from the start (the same values PATCH takes); left out or
   *  null = the default tile. */
  icon: FolderIconBody.optional(),
  color: FolderColorBody.nullable().optional(),
});

/** POST /api/tree/:kind/folders: create a folder, with its icon and colour
 *  when chosen; answers `{ folder }`. */
export async function POST(req: Request, ctx: { params: Promise<{ kind: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const kind = await treeKindOr404(ctx);
  if (kind instanceof Response) return kind;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success)
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  await ensureTreeRoot(user.id, kind);
  try {
    const folder = await createTreeFolder(user.id, kind, parsed.data);
    await notifyTreeChanged(user.id, kind);
    return NextResponse.json({ folder }, { status: 201 });
  } catch (err) {
    return treeErrorResponse(err);
  }
}
