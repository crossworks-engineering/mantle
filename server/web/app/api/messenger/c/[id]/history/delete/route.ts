import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { anyLoginCaller } from '@/lib/auth';
import { readBody } from '@/lib/read-body';
import { deleteMessengerHistory, messengerActorOf } from '@/lib/messenger';
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

const HistoryBody = z.object({ before: z.string().datetime({ offset: true }).optional() });

/** POST /api/messenger/c/:id/history/delete {before?}: a group admin
 *  deletes every message of the group, or those older than `before`, for
 *  everyone. A direct chat has none (clear it instead). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const login = anyLoginCaller();
  const { id } = await ctx.params;
  const body = await readBody(req, HistoryBody);
  const out = await deleteMessengerHistory(
    messengerActorOf(login),
    id,
    body.before ? new Date(body.before) : null,
  );
  return NextResponse.json(out);
}
