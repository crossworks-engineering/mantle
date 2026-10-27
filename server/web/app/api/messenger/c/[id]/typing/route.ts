import { NextResponse } from '@/server/http-compat';
import { anyLoginCaller } from '@/lib/auth';
import { messengerActorOf, messengerTyping } from '@/lib/messenger';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  POST: {
    class: 'self',
    scope: null,
    open: 'any',
    item: { none: 'an ephemeral typing event, stored nowhere' },
    limits: { rateLimit: ['messengerTyping'] },
  },
});

/** POST /api/messenger/c/:id/typing: "I am typing" to the other live
 *  participants. A NOTIFY only; nothing is stored. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const login = anyLoginCaller();
  const { id } = await ctx.params;
  await messengerTyping(messengerActorOf(login), id);
  return NextResponse.json({ ok: true });
}
