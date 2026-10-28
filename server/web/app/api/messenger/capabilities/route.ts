import { NextResponse } from '@/server/http-compat';
import { anyLoginCaller } from '@/lib/auth';
import { callCapabilities } from '@/lib/messenger';
import { routePolicy } from '@/lib/auth/route-declaration';
import type { MessengerCapabilities } from '@mantle/client-types/dto/calls';

export const policy = routePolicy({
  GET: { class: 'self', scope: null, open: 'any', limits: { rateLimit: ['messengerRead'] } },
});

/** GET /api/messenger/capabilities: whether this brain shows a Call button
 *  (the Calls service is on), an agent Call button (the agent worker is
 *  registered) and video (never, in P1). Cached a minute client-side. */
export async function GET() {
  anyLoginCaller();
  return NextResponse.json(callCapabilities() satisfies MessengerCapabilities);
}
