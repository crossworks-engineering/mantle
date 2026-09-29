/**
 * DELETE /api/team-admin/clients/:id/comments (client logins C5 audit, I2):
 * remove every comment that client login wrote on this brain, the client
 * threads and its review talk, in one step (a flood is not cleaned up one
 * comment at a time). Answers `{ deleted }` (0 when there were none). The
 * day's comment cap is not given back. Audited. Admin only.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { deleteClientComments } from '@mantle/content';
import type { ClientCommentsDeleted } from '@mantle/client-types';
import { getOwnerOr401 } from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';

const Params = z.object({ id: z.string().uuid() });

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const params = Params.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Client not found.' }, { status: 404 });
  const deleted = await deleteClientComments(user.id, params.data.id);
  auditFireAndForget({
    actorId: user.actor.id,
    actorEmail: user.actor.email,
    action: 'client.comments_deleted',
    method: 'DELETE',
    path: `/api/team-admin/clients/${params.data.id}/comments`,
    detail: { targetId: params.data.id, deleted },
    ...requestMetaFrom(req),
  });
  const body: ClientCommentsDeleted = { deleted };
  return NextResponse.json(body);
}
