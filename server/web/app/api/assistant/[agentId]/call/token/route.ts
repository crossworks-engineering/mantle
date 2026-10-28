import { NextResponse } from '@/server/http-compat';
import { anyLoginCaller } from '@/lib/auth';
import { messengerActorOf, startAssistantCall } from '@/lib/messenger';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';
import type { MessengerCallJoinResponse } from '@mantle/client-types/dto/calls';

export const routeParams = { agentId: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  POST: {
    class: 'self',
    scope: null,
    open: 'any',
    effect: { read: 'mints a fresh token for the assistant room; no row is written' },
    limits: { rateLimit: ['messengerCallToken'] },
  },
});

/** POST /api/assistant/:agentId/call/token: a fresh hour for the assistant
 *  room, no device swap. */
export async function POST(_req: Request, ctx: { params: Promise<{ agentId: string }> }) {
  const login = anyLoginCaller();
  const { agentId } = await ctx.params;
  const out = await startAssistantCall(messengerActorOf(login), agentId, { refresh: true });
  return NextResponse.json(out satisfies MessengerCallJoinResponse);
}
