import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { TREE_FOLDER_NAME_MAX, TREE_SHARE_LEVELS } from '@mantle/client-types/tree';
import { deleteTreeFolder, notifyTreeChanged, updateTreeFolder } from '@mantle/content/tree';
import { firstIssue } from '@/lib/zod-issue';
import {
  FolderColorBody,
  FolderIconBody,
  treeErrorResponse,
  treeKindOr404,
} from '@/lib/tree-route';

type Ctx = { params: Promise<{ kind: string; id: string }> };

const Id = z.string().uuid();
const Patch = z
  .object({
    name: z.string().trim().min(1).max(TREE_FOLDER_NAME_MAX),
    icon: FolderIconBody.nullable(),
    color: FolderColorBody.nullable(),
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
    /** With `confirm`: the `total` the caller was shown; a different change
     *  now is refused again with the new list. */
    seen: z.number().int().min(0),
  })
  .partial()
  .strict()
  .refine((p) => Object.keys(p).some((k) => k !== 'confirm' && k !== 'seen'), 'nothing to change');

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
    const { confirm, seen, ...patch } = parsed.data;
    const folder = await updateTreeFolder(user.id, kind, id.data, patch, { confirm, seen });
    await notifyTreeChanged(user.id, kind);
    return NextResponse.json({ folder });
  } catch (err) {
    return treeErrorResponse(err);
  }
}

/** DELETE /api/tree/:kind/folders/:id[?confirm=true[&seen=N]] — delete a folder;
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
    const q = new URL(req.url).searchParams;
    const confirm = q.get('confirm') === 'true';
    const seen = /^\d+$/.test(q.get('seen') ?? '') ? Number(q.get('seen')) : undefined;
    await deleteTreeFolder(user.id, kind, id.data, { confirm, seen });
    await notifyTreeChanged(user.id, kind);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return treeErrorResponse(err);
  }
}
