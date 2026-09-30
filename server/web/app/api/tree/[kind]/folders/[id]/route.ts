import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { APP_ICON_MAX, APP_TINTS } from '@mantle/client-types/app-nav';
import { TREE_FOLDER_NAME_MAX } from '@mantle/client-types/tree';
import { deleteTreeFolder, notifyTreeChanged, updateTreeFolder } from '@mantle/content/tree';
import { firstIssue } from '@/lib/zod-issue';
import { treeErrorResponse, treeKindOr404 } from '@/lib/tree-route';

type Ctx = { params: Promise<{ kind: string; id: string }> };

const Id = z.string().uuid();
const Patch = z
  .object({
    name: z.string().trim().min(1).max(TREE_FOLDER_NAME_MAX),
    icon: z.string().max(APP_ICON_MAX).nullable(),
    color: z.enum(APP_TINTS).nullable(),
    /** Move under this folder; null = the top level. */
    parentId: z.string().uuid().nullable(),
    /** Place directly after this sibling; null = first. */
    after: z.string().uuid().nullable(),
  })
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, 'nothing to change');

/** PATCH /api/tree/:kind/folders/:id — rename, restyle, move or reorder a
 *  folder (any combination); answers `{ folder }`. */
export async function PATCH(req: Request, ctx: Ctx) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const kind = await treeKindOr404(ctx);
  if (kind instanceof Response) return kind;
  const id = Id.safeParse((await ctx.params).id);
  if (!id.success) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const parsed = Patch.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success)
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  try {
    const folder = await updateTreeFolder(user.id, kind, id.data, parsed.data);
    await notifyTreeChanged(user.id, kind);
    return NextResponse.json({ folder });
  } catch (err) {
    return treeErrorResponse(err);
  }
}

/** DELETE /api/tree/:kind/folders/:id — delete a folder; what it holds moves
 *  up to its parent first (409 when a name there would clash). */
export async function DELETE(_req: Request, ctx: Ctx) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const kind = await treeKindOr404(ctx);
  if (kind instanceof Response) return kind;
  const id = Id.safeParse((await ctx.params).id);
  if (!id.success) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  try {
    await deleteTreeFolder(user.id, kind, id.data);
    await notifyTreeChanged(user.id, kind);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return treeErrorResponse(err);
  }
}
