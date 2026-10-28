import { NextResponse } from '@/server/http-compat';
import { anyLoginCaller } from '@/lib/auth';
import { leaveCall, messengerActorOf } from '@/lib/messenger';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  POST: {
    class: 'self',
    scope: null,
    open: 'any',
    item: { none: 'a messenger call, not an item' },
    limits: { rateLimit: ['messengerWrite'] },
  },
});

/** POST /api/messenger/c/:id/call/leave: a courtesy (the webhook is the
 *  truth): my stay is marked over and the room drops my identity, so the
 *  reconciler closes an empty call faster. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const login = anyLoginCaller();
  const { id } = await ctx.params;
  await leaveCall(messengerActorOf(login), id);
  return NextResponse.json({ ok: true });
}
