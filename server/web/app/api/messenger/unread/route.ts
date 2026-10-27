import { NextResponse } from '@/server/http-compat';
import { anyLoginCaller } from '@/lib/auth';
import { messengerActorOf, messengerUnread } from '@/lib/messenger';
import { routePolicy } from '@/lib/auth/route-declaration';
import type { MessengerUnreadResponse } from '@mantle/client-types/dto/messenger';

export const policy = routePolicy({
  GET: { class: 'self', scope: null, open: 'any', limits: { rateLimit: ['messengerRead'] } },
});

/** GET /api/messenger/unread: the badge: people chats and groups plus the
 *  agent threads (assistant replies after my read cursor). */
export async function GET() {
  const login = anyLoginCaller();
  const out = await messengerUnread(messengerActorOf(login));
  return NextResponse.json(out satisfies MessengerUnreadResponse);
}
