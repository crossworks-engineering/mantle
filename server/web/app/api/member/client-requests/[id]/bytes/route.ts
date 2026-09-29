import { NextResponse } from '@/server/http-compat';
import { withHumanViewer } from '@mantle/db';
import { openClientRequestFile } from '@mantle/content';
import { getMemberForAsset } from '@/lib/auth';
import { SpaceIdParams, memberBytesGate, spaceFileResponse } from '@/lib/member-space';

/**
 * GET /api/member/client-requests/:id/bytes[?thumb=1] : a file a client
 * submitted (or one in a submitted item's bundle), streamed (or a JPEG
 * thumbnail). Read on the team role with the human flag on; anything else is
 * a 404. Auth: a member session or a member `?at=` token. Rate limited per
 * login (429).
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = await getMemberForAsset(req);
  if (member instanceof Response) return member;
  const limited = memberBytesGate(req, member);
  if (limited) return limited;
  const params = SpaceIdParams.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const opened = await withHumanViewer('team', () => openClientRequestFile(params.data.id));
  return spaceFileResponse(req, opened);
}
