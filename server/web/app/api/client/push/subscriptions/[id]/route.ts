import { getClientOr401 } from '@/lib/auth';
import { loginPushUnpair } from '@/lib/push/login-routes';

/**
 * DELETE /api/client/push/subscriptions/:id: unpair one of this login's own
 * devices (mobile_roles_push). Another login's device, or an unknown id, is a 404.
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const client = await getClientOr401();
  if (client instanceof Response) return client;
  return loginPushUnpair(client, (await ctx.params).id);
}
