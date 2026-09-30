import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { APP_ICON_MAX, APP_TINTS } from '@mantle/client-types/app-nav';
import { TREE_FOLDER_NAME_MAX, TREE_SHARE_LEVELS } from '@mantle/client-types/tree';
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
    /** Share it (and everything below it) with the team or clients; null
     *  stops sharing it. */
    share: z.enum(TREE_SHARE_LEVELS).nullable(),
    /** Go ahead although it changes who can see items (else 409 with the
     *  list). */
    confirm: z.boolean(),
  })
  .partial()
  .strict()
  .refine((p) => Object.keys(p).some((k) => k !== 'confirm'), 'nothing to change');

/** PATCH /api/tree/:kind/folders/:id — rename, restyle, move, reorder or
 *  share a folder (any combination); answers `{ folder }`. A move or a share
 *  that changes who can see items answers 409 `{ error: 'visibility',
 *  changes, total }` until it is repeated with `confirm: true`. */
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
    const { confirm, ...patch } = parsed.data;
    const folder = await updateTreeFolder(user.id, kind, id.data, patch, { confirm });
    await notifyTreeChanged(user.id, kind);
    return NextResponse.json({ folder });
  } catch (err) {
    return treeErrorResponse(err);
  }
}

/** DELETE /api/tree/:kind/folders/:id[?confirm=true] — delete a folder;
 *  what it holds moves up to its parent first (409 when a name there would
 *  clash, or with the visibility changes when leaving a shared folder
 *  changes who can see them and `confirm` is not set). */
export async function DELETE(req: Request, ctx: Ctx) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const kind = await treeKindOr404(ctx);
  if (kind instanceof Response) return kind;
  const id = Id.safeParse((await ctx.params).id);
  if (!id.success) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  try {
    const confirm = new URL(req.url).searchParams.get('confirm') === 'true';
    await deleteTreeFolder(user.id, kind, id.data, { confirm });
    await notifyTreeChanged(user.id, kind);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return treeErrorResponse(err);
  }
}
