import { NextResponse } from '@/server/http-compat';
import { anyLoginCaller } from '@/lib/auth';
import { messengerActorOf, removeCallParticipant } from '@/lib/messenger';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

export const routeParams = { id: 'uuid', loginId: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  DELETE: {
    class: 'self',
    scope: null,
    open: 'any',
    item: { none: 'a messenger call, not an item' },
    limits: { rateLimit: ['messengerWrite'] },
  },
});

/** DELETE /api/messenger/c/:id/call/participants/:loginId: a group admin
 *  drops a person from the call (the room drops the identity). */
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string; loginId: string }> },
) {
  const login = anyLoginCaller();
  const { id, loginId } = await ctx.params;
  await removeCallParticipant(messengerActorOf(login), id, loginId);
  return NextResponse.json({ ok: true });
}
