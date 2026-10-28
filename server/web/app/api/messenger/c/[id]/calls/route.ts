import { NextResponse } from '@/server/http-compat';
import { anyLoginCaller } from '@/lib/auth';
import { listCalls, messengerActorOf, seqQuery } from '@/lib/messenger';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';
import type { MessengerCallsResponse } from '@mantle/client-types/dto/calls';

export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  GET: { class: 'self', scope: null, open: 'any', limits: { rateLimit: ['messengerRead'] } },
});

/** GET /api/messenger/c/:id/calls?before=<ISO>&limit=: the chat's calls,
 *  newest first (the system lines already show them; this feeds a "Calls"
 *  filter later). */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const login = anyLoginCaller();
  const { id } = await ctx.params;
  const params = new URL(req.url).searchParams;
  const limit = seqQuery(params, 'limit');
  if (limit === 'bad')
    return NextResponse.json({ error: 'limit is a whole number' }, { status: 400 });
  const out = await listCalls(messengerActorOf(login), id, {
    before: params.get('before'),
    limit,
  });
  return NextResponse.json(out satisfies MessengerCallsResponse);
}
