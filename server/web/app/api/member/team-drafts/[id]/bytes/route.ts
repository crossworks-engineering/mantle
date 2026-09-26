import { NextResponse } from '@/server/http-compat';
import { withTeamDrafts } from '@mantle/db';
import { openTeamDraftFile } from '@mantle/content';
import { getMemberForAsset } from '@/lib/auth';
import { SpaceIdParams, spaceFileResponse } from '@/lib/member-space';

/**
 * GET /api/member/team-drafts/:id/bytes[?thumb=1] : a teammate's file that is
 * shared with the team, streamed (or a JPEG thumbnail). Read on the team role
 * with the human flag on; a private file is a 404. Auth: a member session or
 * a member `?at=` token.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = await getMemberForAsset(req);
  if (member instanceof Response) return member;
  const params = SpaceIdParams.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const opened = await withTeamDrafts(() => openTeamDraftFile(params.data.id));
  return spaceFileResponse(req, opened);
}
