import { memberCaller } from '@/lib/auth';
import { loginPushUnpair } from '@/lib/push/login-routes';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  DELETE: {
    class: 'self',
    open: 'member',
    item: { none: "one of the login's own push devices, found by the login" },
  },
});

/**
 * DELETE /api/member/push/subscriptions/:id: unpair one of this login's own
 * devices (mobile_roles_push). Another login's device, or an unknown id, is a 404.
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = memberCaller();
  return loginPushUnpair(member, (await ctx.params).id);
}
