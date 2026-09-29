import { NextResponse } from '@/server/http-compat';
import { deleteClientThreadComment } from '@mantle/content';
import { getClientOr401 } from '@/lib/auth';
import { ThreadCommentParams, clientThreadWriteGate } from '@/lib/client-thread';

/** DELETE /api/client/shared/:id/comments/:commentId : remove one of the
 *  client's own comments on the client thread (its own login, scope client).
 *  Anything else is a plain 404. */
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string; commentId: string }> },
) {
  const client = await getClientOr401();
  if (client instanceof Response) return client;
  const limited = clientThreadWriteGate(client);
  if (limited) return limited;
  const params = ThreadCommentParams.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const ok = await deleteClientThreadComment(
    client.anchorId,
    params.data.id,
    { kind: 'client', loginId: client.loginId },
    params.data.commentId,
  );
  return ok
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: 'Not found.' }, { status: 404 });
}
