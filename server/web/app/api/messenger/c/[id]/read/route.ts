import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { anyLoginCaller } from '@/lib/auth';
import { readBody } from '@/lib/read-body';
import { markMessengerRead, messengerActorOf } from '@/lib/messenger';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  POST: {
    class: 'self',
    scope: null,
    open: 'any',
    item: { none: 'a messenger read cursor, not an item' },
    limits: { rateLimit: ['messengerWrite'] },
  },
});

const ReadBody = z.object({ seq: z.number().int().min(0) });

/** POST /api/messenger/c/:id/read {seq}: move my read cursor forward
 *  (never back). Answers the cursor. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const login = anyLoginCaller();
  const { id } = await ctx.params;
  const body = await readBody(req, ReadBody);
  return NextResponse.json(await markMessengerRead(messengerActorOf(login), id, body.seq));
}
