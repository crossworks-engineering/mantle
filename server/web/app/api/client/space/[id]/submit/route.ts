import { NextResponse } from '@/server/http-compat';
import { submitItem } from '@mantle/content';
import { getClientOr401 } from '@/lib/auth';
import {
  assertClientItem,
  clientWithAdminGuard,
  clientWriteGate,
  inMyClientSpace,
} from '@/lib/client-space';
import { SpaceIdParams, spaceStateResponse } from '@/lib/member-space';

/**
 * POST /api/client/space/:id/submit : send the CLIENT's item, its SAVED version,
 * to the reviewers (draft or returned -> submitted; client logins C5).
 * Unsaved edits refuse with 409 `unsaved-draft`. The client's caps apply
 * (409 `quota`): 10 submissions in 24 hours (Recall and Submit again still
 * counts) and 50 waiting for review. From here the item is FROZEN until
 * Accept, Return or Recall.
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
      return submitItem(client.spaceId, params.data.id);
    });
    return NextResponse.json({ item });
  } catch (err) {
    return spaceStateResponse(err);
  }
}
