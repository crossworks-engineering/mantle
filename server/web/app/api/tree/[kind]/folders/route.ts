import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { TREE_FOLDER_NAME_MAX } from '@mantle/client-types/tree';
import { createTreeFolder, notifyTreeChanged } from '@mantle/content/tree';
import { LookColorBody, LookIconBody } from '@/lib/look-body';
import { ensureTreeRoot, treeKindOr404 } from '@/lib/tree-route';
import { readBody } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'content',
    open: 'owner',
    creates: true,
    item: { none: 'not decided yet: the write names an item no check reads' },
  },
});

const Body = z.object({
  /** The folder to create it in; null = the top level. */
  parentId: z.string().uuid().nullable(),
  name: z.string().trim().min(1).max(TREE_FOLDER_NAME_MAX),
  /** Its look from the start (the same values PATCH takes); left out or
   *  null = the default tile. */
  icon: LookIconBody.optional(),
  color: LookColorBody.nullable().optional(),
});

/** POST /api/tree/:kind/folders: create a folder, with its icon and colour
 *  when chosen; answers `{ folder }`. */
export async function POST(req: Request, ctx: { params: Promise<{ kind: string }> }) {
  const user = ownerCaller();
  const kind = await treeKindOr404(ctx);
  if (kind instanceof Response) return kind;
  const body = await readBody(req, Body);
  await ensureTreeRoot(user.id, kind);
  const folder = await createTreeFolder(user.id, kind, body);
  await notifyTreeChanged(user.id, kind);
  return NextResponse.json({ folder }, { status: 201 });
}
