import { getMemberOr401 } from '@/lib/auth';
import { loginPushUnpair } from '@/lib/push/login-routes';

/**
 * DELETE /api/member/push/subscriptions/:id: unpair one of this login's own
 * devices (mobile_roles_push). Another login's device, or an unknown id, is a 404.
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  return loginPushUnpair(member, (await ctx.params).id);
}
