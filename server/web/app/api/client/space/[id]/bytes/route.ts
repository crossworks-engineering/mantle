import { NextResponse } from '@/server/http-compat';
import { openMineFile } from '@mantle/content';
import { getClientForAsset } from '@/lib/auth';
import { clientBytesGate } from '@/lib/client-bytes';
import { clientWithAdminGuard, inMyClientSpace } from '@/lib/client-space';
import { spaceFileResponse, SpaceIdParams } from '@/lib/member-space';

/**
 * GET /api/client/space/:id/bytes[?thumb=1] : one of the CLIENT's own
 * files, streamed (or a JPEG thumbnail; client logins C5). Auth: a client
 * session or a client `?at=` token (an <img> src cannot carry a bearer);
 * the read runs in the space of the client the token names, so another
 * login's file is a 404. Rate limited per login (429).
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const client = await getClientForAsset(req);
  if (client instanceof Response) return client;
  const limited = clientBytesGate(req, client);
  if (limited) return limited;
  const params = SpaceIdParams.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const held = await clientWithAdminGuard(client, params.data.id);
  if (held) return held;
  const opened = await inMyClientSpace(client, () => openMineFile(client.spaceId, params.data.id));
  return spaceFileResponse(req, opened);
}
