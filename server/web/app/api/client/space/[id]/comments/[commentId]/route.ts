import { NextResponse } from '@/server/http-compat';
import { deleteMineComment } from '@mantle/content';
import { getClientOr401 } from '@/lib/auth';
import {
  assertClientItem,
  clientWithAdminGuard,
  clientWriteGate,
  inMyClientSpace,
} from '@/lib/client-space';
import { CommentParams, notFound, spaceStateResponse } from '@/lib/member-space';

/** DELETE /api/client/space/:id/comments/:commentId : remove one of the
 *  CLIENT's own comments on one of their own items (client logins C5). A
 *  reviewer's comment is not theirs: a 404. */
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string; commentId: string }> },
) {
  const client = await getClientOr401();
  if (client instanceof Response) return client;
  const limited = clientWriteGate(client);
  if (limited) return limited;
  const params = CommentParams.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const held = await clientWithAdminGuard(client, params.data.id);
  if (held) return held;
  try {
    const ok = await inMyClientSpace(client, async () => {
      await assertClientItem(client.spaceId, params.data.id);
      return deleteMineComment(client.spaceId, params.data.id, params.data.commentId);
    });
    return ok ? NextResponse.json({ ok: true }) : notFound();
  } catch (err) {
    return spaceStateResponse(err);
  }
}
