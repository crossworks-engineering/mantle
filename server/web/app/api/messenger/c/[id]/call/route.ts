import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { anyLoginCaller } from '@/lib/auth';
import { readBody } from '@/lib/read-body';
import { messengerActorOf, startOrJoinCall } from '@/lib/messenger';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';
import type { MessengerCallJoinResponse } from '@mantle/client-types/dto/calls';

export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  POST: {
    class: 'self',
    scope: null,
    open: 'any',
    item: { none: 'a messenger call, not an item' },
    limits: { rateLimit: ['messengerCall'] },
  },
});

const StartBody = z.object({ device: z.string().max(32).nullable().optional() });

/** POST /api/messenger/c/:id/call: start the chat's call, or join the open
 *  one. A live participant gets a one-hour token for the one room and the
 *  ICE override; a leaver is refused; an outsider hears "not found"; with
 *  calls off, one clear 404. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const login = anyLoginCaller();
  const { id } = await ctx.params;
  const body = await readBody(req, StartBody, { empty: {} });
  const out = await startOrJoinCall(messengerActorOf(login), id, { device: body.device });
  return NextResponse.json(out satisfies MessengerCallJoinResponse);
}
