import { NextResponse } from '@/server/http-compat';
import { openMineFile } from '@mantle/content';
import { getMemberForAsset } from '@/lib/auth';
import {
  inMySpace,
  memberBytesGate,
  spaceFileResponse,
  SpaceIdParams,
  withAdminGuard,
} from '@/lib/member-space';

/**
 * GET /api/member/space/:id/bytes[?thumb=1] : one of the member's own files,
 * streamed (or a JPEG thumbnail). Auth: a member session or a member `?at=`
 * token (an <img> src cannot carry a bearer). Another member's file is a 404.
 * Rate limited per login (429).
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = await getMemberForAsset(req);
  if (member instanceof Response) return member;
  const limited = memberBytesGate(req, member);
  if (limited) return limited;
  const params = SpaceIdParams.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const held = await withAdminGuard(member, params.data.id);
  if (held) return held;
  const opened = await inMySpace(member, () => openMineFile(member.spaceId, params.data.id));
  return spaceFileResponse(req, opened);
}
