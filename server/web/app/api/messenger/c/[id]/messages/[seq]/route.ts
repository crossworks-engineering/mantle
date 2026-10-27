import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { anyLoginCaller } from '@/lib/auth';
import { readBody } from '@/lib/read-body';
import {
  deleteMessengerMessage,
  editMessengerMessage,
  messengerActorOf,
  notFound,
  seqParam,
} from '@/lib/messenger';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  PATCH: {
    class: 'self',
    scope: null,
    open: 'any',
    item: { none: 'a messenger message, not an item' },
    limits: { rateLimit: ['messengerWrite'] },
  },
  DELETE: {
    class: 'self',
    scope: null,
    open: 'any',
    item: { none: 'a messenger message, not an item' },
    limits: { rateLimit: ['messengerWrite'] },
  },
});

const EditBody = z.object({ body: z.string().max(8000) });

/** PATCH /api/messenger/c/:id/messages/:seq: edit my own message. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string; seq: string }> }) {
  const login = anyLoginCaller();
  const { id, seq } = await ctx.params;
  const s = seqParam(seq);
  if (s === null) return notFound();
  const body = await readBody(req, EditBody);
  const message = await editMessengerMessage(messengerActorOf(login), id, s, body.body);
  return NextResponse.json({ message });
}

/** DELETE /api/messenger/c/:id/messages/:seq: delete for everyone (my own
 *  message; a group admin any message of the group). */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string; seq: string }> }) {
  const login = anyLoginCaller();
  const { id, seq } = await ctx.params;
  const s = seqParam(seq);
  if (s === null) return notFound();
  await deleteMessengerMessage(messengerActorOf(login), id, s);
  return NextResponse.json({ ok: true });
}
