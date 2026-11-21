import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { anyLoginCaller } from '@/lib/auth';
import { readBody } from '@/lib/read-body';
import { messengerActorOf, openHandleChat } from '@/lib/messenger';
import { routePolicy } from '@/lib/auth/route-declaration';
import type { MessengerOpenToResponse } from '@mantle/client-types/dto/messenger';

export const policy = routePolicy({
  POST: {
    class: 'self',
    scope: null,
    open: 'any',
    item: { none: 'a messenger conversation, not an item' },
    limits: { rateLimit: ['messengerWrite'] },
  },
});

const ToBody = z.object({
  handle: z.string().min(1).max(64),
  // An IT desk's site (the Control Center's name); a local handle has none.
  site: z.string().max(40).optional(),
});

/** POST /api/messenger/to {handle, site?}: the chat a post to a handle
 *  goes in (fleet chat): the group for a member, else my own "To @handle"
 *  thread, made once. An IT desk: my own "To @bugs (IT)" thread. The app opens it so files can be added before the first
 *  send. */
export async function POST(req: Request) {
  const login = anyLoginCaller();
  const body = await readBody(req, ToBody);
  const out = await openHandleChat(messengerActorOf(login), body.handle, body.site);
  return NextResponse.json(out satisfies MessengerOpenToResponse);
}
