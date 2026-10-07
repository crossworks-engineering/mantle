import { getClientOr401 } from '@/lib/auth';
import { loginPushConnect } from '@/lib/push/login-routes';

/**
 * POST /api/client/push/connect { platform, osPushToken } -> { ticket,
 * relayUrl }: the Connect step for a CLIENT login's phone (migration mobile_roles_push,
 * docs/mobile-companion-backend.md "Three roles on the phone"). The app takes
 * the ticket to the relay's /enroll, then posts the routing token to
 * /api/client/push/subscriptions. A client never
 * registers this brain with the relay: until an admin or a member has
 * connected once, the answer is 409 `push_not_set_up`.
 */
export async function POST(req: Request) {
  const client = await getClientOr401();
  if (client instanceof Response) return client;
  return loginPushConnect(req, client);
}
