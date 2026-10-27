import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { anyLoginCaller } from '@/lib/auth';
import { readBody } from '@/lib/read-body';
import { addMessengerParticipants, messengerActorOf } from '@/lib/messenger';
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

const AddBody = z.object({ logins: z.array(z.string().uuid()).min(1).max(200) });

/** POST /api/messenger/c/:id/participants: a group admin adds people who
 *  share a workspace with them (Admin users: anyone). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const login = anyLoginCaller();
  const { id } = await ctx.params;
  const body = await readBody(req, AddBody);
  const out = await addMessengerParticipants(messengerActorOf(login), id, body.logins);
  return NextResponse.json(out);
}
