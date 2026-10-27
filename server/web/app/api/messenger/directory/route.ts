import { NextResponse } from '@/server/http-compat';
import { anyLoginCaller } from '@/lib/auth';
import { messengerActorOf, messengerDirectory } from '@/lib/messenger';
import { routePolicy } from '@/lib/auth/route-declaration';
import type { MessengerDirectoryResponse } from '@mantle/client-types/dto/messenger';

export const policy = routePolicy({
  GET: { class: 'self', scope: null, open: 'any', limits: { rateLimit: ['messengerRead'] } },
});

/** GET /api/messenger/directory?q=: who I may chat with: the people who
 *  share a workspace with me (Admin users: everyone), with "online", then
 *  the agents I may chat with. */
export async function GET(req: Request) {
  const login = anyLoginCaller();
  const q = (new URL(req.url).searchParams.get('q') ?? '').slice(0, 100);
  const entries = await messengerDirectory(messengerActorOf(login), q);
  return NextResponse.json({ entries } satisfies MessengerDirectoryResponse);
}
