import { NextResponse } from '@/server/http-compat';
import { anyLoginCaller } from '@/lib/auth';
import { messengerActorOf, refreshCallToken } from '@/lib/messenger';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';
import type { MessengerCallJoinResponse } from '@mantle/client-types/dto/calls';

export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  POST: {
    class: 'self',
    scope: null,
    open: 'any',
    effect: { read: 'mints a fresh token for the open call; writes nothing' },
    limits: { rateLimit: ['messengerCallToken'] },
  },
});

/** POST /api/messenger/c/:id/call/token: a fresh hour for the open call,
 *  with the same checks as a join (the gate is re-checked). */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const login = anyLoginCaller();
  const { id } = await ctx.params;
  const out = await refreshCallToken(messengerActorOf(login), id);
  return NextResponse.json(out satisfies MessengerCallJoinResponse);
}
