import { NextResponse } from '@/server/http-compat';
import { anyLoginCaller } from '@/lib/auth';
import { clearMessengerForMe, messengerActorOf } from '@/lib/messenger';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  POST: {
    class: 'self',
    scope: null,
    open: 'any',
    item: { none: 'a messenger conversation, not an item' },
    limits: { rateLimit: ['messengerWrite'] },
  },
});

/** POST /api/messenger/c/:id/clear: Clear for me: I see nothing up to the last message; nobody else is affected. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const login = anyLoginCaller();
  const { id } = await ctx.params;
  const out = await clearMessengerForMe(messengerActorOf(login), id);
  return NextResponse.json(out);
}
