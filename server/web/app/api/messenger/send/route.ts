import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { anyLoginCaller } from '@/lib/auth';
import { readBody } from '@/lib/read-body';
import { messengerActorOf, sendMessengerTo } from '@/lib/messenger';
import { routePolicy } from '@/lib/auth/route-declaration';
import type { MessengerSendToResponse } from '@mantle/client-types/dto/messenger';

export const policy = routePolicy({
  POST: {
    class: 'self',
    scope: null,
    open: 'any',
    item: { none: 'a messenger message, not an item' },
    limits: { rateLimit: ['messengerSend'] },
  },
});

const SendToBody = z.object({
  // An IT desk (bugs, feature, requests) may name its site, the Control
  // Center's name (IT); a local handle names none.
  to: z.object({ handle: z.string().min(1).max(64), site: z.string().max(40).optional() }),
  // Empty only with answers (the filled form is the text).
  body: z.string().max(8000),
  answers: z.record(z.string().max(64), z.string().max(2000)).optional(),
  clientMsgId: z.string().min(1).max(100).nullable().optional(),
});

/** POST /api/messenger/send: post to a handle with no open chat (fleet
 *  chat, 0394). A member of the handle's group posts in the group; anyone
 *  else in their own thread "To @handle", made once. An IT desk (fleet chat
 *  M3): my own thread "To @bugs (IT)", and the line is a Send to IT. The line names the
 *  handle, so the copy line and the line back work as from any chat.
 *  Answers the chat it went in and the stored line. */
export async function POST(req: Request) {
  const login = anyLoginCaller();
  const body = await readBody(req, SendToBody);
  const out = await sendMessengerTo(messengerActorOf(login), body.to, {
    body: body.body,
    answers: body.answers ?? null,
    clientMsgId: body.clientMsgId ?? null,
  });
  return NextResponse.json(out satisfies MessengerSendToResponse, {
    status: out.created ? 201 : 200,
  });
}
