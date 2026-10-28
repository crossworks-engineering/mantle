import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { anyLoginCaller } from '@/lib/auth';
import { readBody } from '@/lib/read-body';
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
    effect: { read: 'mints a token for the assistant room; no row is written' },
    limits: { rateLimit: ['messengerCall'] },
  },
});

const StartBody = z.object({ device: z.string().max(32).nullable().optional() });

/** POST /api/assistant/:agentId/call: a token for the room with your own
 *  assistant (asst-<agent>-<login>), for an agent you may chat with, where
 *  the agent worker is registered (MANTLE_CALLS_AGENT; the worker is P2). */
export async function POST(req: Request, ctx: { params: Promise<{ agentId: string }> }) {
  const login = anyLoginCaller();
  const { agentId } = await ctx.params;
  const body = await readBody(req, StartBody, { empty: {} });
  const out = await startAssistantCall(messengerActorOf(login), agentId, { device: body.device });
  return NextResponse.json(out satisfies MessengerCallJoinResponse);
}
