import { NextResponse } from '@/server/http-compat';
import { recallItem } from '@mantle/content';
import { getClientOr401 } from '@/lib/auth';
import {
  assertClientItem,
  clientWithAdminGuard,
  clientWriteGate,
  inMyClientSpace,
} from '@/lib/client-space';
import { SpaceIdParams, spaceStateResponse } from '@/lib/member-space';

/**
 * POST /api/client/space/:id/recall : take a submitted item back for
 * correction (submitted -> draft; client logins C5), any time before a
 * reviewer accepts it. The submission still counts toward the day's cap.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const client = await getClientOr401();
  if (client instanceof Response) return client;
  const limited = clientWriteGate(client);
  if (limited) return limited;
  const params = SpaceIdParams.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const held = await clientWithAdminGuard(client, params.data.id);
  if (held) return held;
  try {
    const item = await inMyClientSpace(client, async () => {
      await assertClientItem(client.spaceId, params.data.id);
      return recallItem(client.spaceId, params.data.id);
    });
    return NextResponse.json({ item });
  } catch (err) {
    return spaceStateResponse(err);
  }
}
