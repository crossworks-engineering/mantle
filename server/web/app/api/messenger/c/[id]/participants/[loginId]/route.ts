import { NextResponse } from '@/server/http-compat';
import { anyLoginCaller } from '@/lib/auth';
import { messengerActorOf, removeMessengerParticipant } from '@/lib/messenger';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

export const routeParams = { id: 'uuid', loginId: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  DELETE: {
    class: 'self',
    scope: null,
    open: 'any',
    item: { none: 'a messenger conversation, not an item' },
    limits: { rateLimit: ['messengerWrite'] },
  },
});

/** DELETE /api/messenger/c/:id/participants/:loginId: a group admin
 *  removes someone (they keep reading up to the line that says so). */
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string; loginId: string }> },
) {
  const login = anyLoginCaller();
  const { id, loginId } = await ctx.params;
  await removeMessengerParticipant(messengerActorOf(login), id, loginId);
  return NextResponse.json({ ok: true });
}
