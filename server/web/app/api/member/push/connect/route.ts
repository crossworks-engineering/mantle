import { memberCaller } from '@/lib/auth';
import { loginPushConnect } from '@/lib/push/login-routes';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'self',
    open: 'member',
    item: { none: "the login's own things, not an item" },
    limits: { rateLimit: ['pushEnrol'] },
  },
});

/**
 * POST /api/member/push/connect { platform, osPushToken } -> { ticket,
 * relayUrl }: the Connect step for a MEMBER login's phone (migration mobile_roles_push,
 * docs/mobile-companion-backend.md "Every login on the phone"). The app takes
 * the ticket to the relay's /enroll, then posts the routing token to
 * /api/member/push/subscriptions. A member may
 * be the one who registers this brain with the relay (the first Connect).
 */
export async function POST(req: Request) {
  const member = memberCaller();
  return loginPushConnect(req, member);
}
