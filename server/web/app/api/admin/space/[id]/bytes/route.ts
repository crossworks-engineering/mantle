import { NextResponse } from '@/server/http-compat';
import { openMineFile } from '@mantle/content';
import { getAdminSpaceForAsset, inAdminSpace } from '@/lib/admin-space';
import { SpaceIdParams, spaceFileResponse } from '@/lib/member-space';

/**
 * GET /api/admin/space/:id/bytes[?thumb=1] : one of the calling admin's own
 * private files, streamed (or a JPEG thumbnail), as
 * GET /api/member/space/:id/bytes. Auth: an admin session or the owner
 * `?at=` token (an <img> src cannot carry a bearer); the token's `act` claim
 * names the login, whose own space is read. Another login's file is a 404.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const caller = await getAdminSpaceForAsset(req);
  if (caller instanceof Response) return caller;
  const params = SpaceIdParams.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const opened = await inAdminSpace(caller, () => openMineFile(caller.spaceId, params.data.id));
  return spaceFileResponse(req, opened);
}
