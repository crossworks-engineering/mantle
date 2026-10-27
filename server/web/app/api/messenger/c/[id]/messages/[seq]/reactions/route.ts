import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { anyLoginCaller } from '@/lib/auth';
import { readBody } from '@/lib/read-body';
import { messengerActorOf, notFound, seqParam, toggleMessengerReaction } from '@/lib/messenger';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  POST: {
    class: 'self',
    scope: null,
    open: 'any',
    item: { none: 'a messenger message, not an item' },
    limits: { rateLimit: ['messengerWrite'] },
  },
});

const ReactBody = z.object({ emoji: z.string().min(1).max(32) });

/** POST /api/messenger/c/:id/messages/:seq/reactions: toggle one emoji of
 *  mine; answers whether it is on now. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string; seq: string }> }) {
  const login = anyLoginCaller();
  const { id, seq } = await ctx.params;
  const s = seqParam(seq);
  if (s === null) return notFound();
  const body = await readBody(req, ReactBody);
  return NextResponse.json(await toggleMessengerReaction(messengerActorOf(login), id, s, body.emoji));
}
