/**
 * POST /api/team-admin/submissions/:id/accept
 *   { audience?: 'admin'|'team'|'client'|'public', parentPageId?, folderPath? }
 * Accept into the brain (plan 6.2): the item and its bundle move into the
 * brain with the same ids, at the chosen level (admin by default). 404 when
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
  parentPageId: z.string().uuid().nullable().optional(),
  folderPath: z.string().max(500).nullable().optional(),
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
