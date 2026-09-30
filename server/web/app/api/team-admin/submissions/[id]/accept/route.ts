/**
 * POST /api/team-admin/submissions/:id/accept
 *   { audience?: 'admin'|'team'|'client'|'public', parentPageId?, folderPath?,
 *     folderId?, lowerConfirmed?, confirmedIds? }
 * `visibilityConfirmed`: it lands in a shared folder and is read above the
 * chosen level there, and the admin saw the list (else 409 `visibility`
 * with `changes` and `total`, before anything moves).
 * `folderId` (folder plan phase 5): where the item lands; left out, it stays
 * in the brain folder it was filed in (the author's own folders below it
 * become brain folders); null is the top level. `folderPath` is the Files
 * folder of a client from before the tree.
 * Accept into the brain (plan 6.2): the item and its bundle move into the
 * brain with the same ids, at the chosen level (admin by default; team for
 * an item a client wrote, and client or public for one only with
 * `lowerConfirmed` AND every brain item that goes down with it in
 * `confirmedIds`, else 409 `confirm-level` with `goingDown`: client logins
 * C1, audit A28; the bundle preview lists them in `closure`). 404 when
 * it is not waiting any more (the author recalled it first). The only member-logins
 * path that announces anything to the extractor.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { VIEWER_LEVELS } from '@mantle/db';
import { acceptReviewItem } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';
import {
  SubmissionParams,
  reviewErrorResponse,
  reviewNotFound,
  reviewer,
} from '@/lib/member-review';

const Body = z.object({
  audience: z.enum(VIEWER_LEVELS).optional(),
  /** DEPRECATED (folder phase 7): pages do not nest; accepted and ignored. */
  parentPageId: z.string().uuid().nullable().optional(),
  folderPath: z.string().max(500).nullable().optional(),
  folderId: z.string().uuid().nullable().optional(),
  lowerConfirmed: z.boolean().optional(),
  confirmedIds: z.array(z.string().uuid()).max(5000).optional(),
  visibilityConfirmed: z.boolean().optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const params = SubmissionParams.safeParse(await ctx.params);
  if (!params.success) return reviewNotFound();
  const body = Body.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: 'Invalid accept.' }, { status: 400 });
  try {
    const res = await acceptReviewItem(user.id, params.data.id, reviewer(user), body.data);
    return NextResponse.json(res);
  } catch (err) {
    return reviewErrorResponse(err);
  }
}
