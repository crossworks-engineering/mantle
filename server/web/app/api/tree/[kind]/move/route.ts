import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { moveTreeItems, notifyTreeChanged } from '@mantle/content/tree';
import { movedAppToolWarnings } from '@mantle/tools';
import { firstIssue } from '@/lib/zod-issue';
import { treeErrorResponse, treeKindOr404 } from '@/lib/tree-route';

const Body = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  /** The destination folder; null = the root (unsorted). */
  folderId: z.string().uuid().nullable(),
  /** Go ahead although it changes who can see items (else 409 with the list). */
  confirm: z.boolean().optional(),
  /** With `confirm`: the `total` the caller was shown; a different change
   *  now is refused again with the new list. */
  seen: z.number().int().min(0).optional(),
});

/** POST /api/tree/:kind/move — move items into a folder. Each item moves on
 *  its own; `failed` lists the ones that could not (TreeMoveResult). */
export async function POST(req: Request, ctx: { params: Promise<{ kind: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const kind = await treeKindOr404(ctx);
  if (kind instanceof Response) return kind;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success)
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  try {
    const result = await moveTreeItems(user.id, kind, parsed.data.ids, parsed.data.folderId, {
      confirm: parsed.data.confirm,
      seen: parsed.data.seen,
    });
    if (result.moved) await notifyTreeChanged(user.id, kind);
    // An app's folder can set the level it is used at (a client-shared
    // folder, M5): say which declared tools its runs now refuse (N11).
    if (kind === 'apps' && result.moved) {
      const failed = new Set(result.failed.map((f) => f.id));
      const warnings = await movedAppToolWarnings(
        user.id,
        [...new Set(parsed.data.ids)].filter((id) => !failed.has(id)),
      );
      if (warnings.length) return NextResponse.json({ ...result, warnings });
    }
    return NextResponse.json(result);
  } catch (err) {
    return treeErrorResponse(err);
  }
}
