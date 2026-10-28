import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { anyLoginCaller } from '@/lib/auth';
import { readBody } from '@/lib/read-body';
import { addCallAgent, messengerActorOf, removeCallAgent } from '@/lib/messenger';
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
  DELETE: {
    class: 'self',
    scope: null,
    open: 'any',
    item: { none: 'a messenger call, not an item' },
    limits: { rateLimit: ['messengerWrite'] },
  },
});

const AgentBody = z.object({ agentId: z.string().uuid() });

/** POST /api/messenger/c/:id/call/agent {agentId}: P2 (an agent as a
 *  group-call guest). Refuses with one line and records nothing; the
 *  participant rule is still checked first. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const login = anyLoginCaller();
  const { id } = await ctx.params;
  const body = await readBody(req, AgentBody);
  await addCallAgent(messengerActorOf(login), id, body.agentId);
  return NextResponse.json({ ok: true });
}

/** DELETE /api/messenger/c/:id/call/agent: P2. Refuses, records nothing. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const login = anyLoginCaller();
  const { id } = await ctx.params;
  await removeCallAgent(messengerActorOf(login), id);
  return NextResponse.json({ ok: true });
}
