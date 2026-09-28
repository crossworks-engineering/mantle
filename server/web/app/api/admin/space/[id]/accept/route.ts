/**
 * POST /api/admin/space/:id/accept
 *   { audience?: 'admin'|'team'|'client'|'public', parentPageId?, folderPath? }
 * An admin accepts one of their OWN private items into the brain, with no
 * review (member logins Phase 7). The same body and answer as
 * POST /api/team-admin/submissions/:id/accept: the item and its bundle move
 * into the brain with the same ids, at the chosen level (admin by default).
 * 404 for anything not in the caller's own space (another admin's item
 * included) or already accepted; 409 `unsaved-draft` while it has unsaved
 * edits (save a version first). The one admin-space path that announces
 * anything to the extractor: once per moved item.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { VIEWER_LEVELS } from '@mantle/db';
import { ReviewError, acceptOwnItem } from '@mantle/content';
import { getAdminSpaceOr401 } from '@/lib/admin-space';
import { SpaceIdParams, notFound, spaceStateResponse } from '@/lib/member-space';
import { reviewErrorResponse } from '@/lib/member-review';

const Body = z.object({
  audience: z.enum(VIEWER_LEVELS).optional(),
  parentPageId: z.string().uuid().nullable().optional(),
  folderPath: z.string().max(500).nullable().optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const caller = await getAdminSpaceOr401();
  if (caller instanceof Response) return caller;
  const params = SpaceIdParams.safeParse(await ctx.params);
  if (!params.success) return notFound();
  const body = Body.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: 'Invalid accept.' }, { status: 400 });
  try {
    const res = await acceptOwnItem(
      caller.brainId,
      { spaceId: caller.spaceId, loginId: caller.loginId },
      params.data.id,
      body.data,
    );
    return NextResponse.json(res);
  } catch (err) {
    if (err instanceof ReviewError) return reviewErrorResponse(err);
    return spaceStateResponse(err);
  }
}
