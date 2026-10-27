import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { anyLoginCaller } from '@/lib/auth';
import { readBody } from '@/lib/read-body';
import {
  listMessengerMessages,
  messengerActorOf,
  seqQuery,
  sendMessengerMessage,
} from '@/lib/messenger';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';
import type {
  MessengerMessagesResponse,
  MessengerSendResponse,
} from '@mantle/client-types/dto/messenger';

export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  GET: { class: 'self', scope: null, open: 'any', limits: { rateLimit: ['messengerRead'] } },
  POST: {
    class: 'self',
    scope: null,
    open: 'any',
    item: { none: 'a messenger message, not an item' },
    limits: { rateLimit: ['messengerSend'] },
  },
});

/** GET /api/messenger/c/:id/messages?before_seq=&after_seq=&limit=: the
 *  last 20, the 20 below before_seq (scrolling up), or everything after
 *  after_seq (the catch-up after a stream event). Oldest first. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const login = anyLoginCaller();
  const { id } = await ctx.params;
  const params = new URL(req.url).searchParams;
  const beforeSeq = seqQuery(params, 'before_seq');
  const afterSeq = seqQuery(params, 'after_seq');
  const limit = seqQuery(params, 'limit');
  if (beforeSeq === 'bad' || afterSeq === 'bad' || limit === 'bad') {
    return NextResponse.json(
      { error: 'before_seq, after_seq and limit are whole numbers' },
      { status: 400 },
    );
  }
  const page = await listMessengerMessages(messengerActorOf(login), id, {
    beforeSeq,
    afterSeq,
    limit,
  });
  return NextResponse.json(page satisfies MessengerMessagesResponse);
}

const SendBody = z.object({
  body: z.string().max(8000),
  mentions: z
    .array(z.object({ kind: z.enum(['login', 'agent']), id: z.string().uuid() }))
    .max(200)
    .optional(),
  replyToSeq: z.number().int().positive().nullable().optional(),
  clientMsgId: z.string().min(1).max(100).nullable().optional(),
  attachments: z.array(z.string().uuid()).max(5).optional(),
});

/** POST /api/messenger/c/:id/messages: send as me. The same clientMsgId
 *  twice stores one message and answers it again. A mention starts nothing
 *  in this phase (agents in groups are Phase 3). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const login = anyLoginCaller();
  const { id } = await ctx.params;
  const body = await readBody(req, SendBody);
  const out = await sendMessengerMessage(messengerActorOf(login), id, body);
  return NextResponse.json(out satisfies MessengerSendResponse, {
    status: out.created ? 201 : 200,
  });
}
