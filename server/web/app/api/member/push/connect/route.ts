import { getMemberOr401 } from '@/lib/auth';
import { loginPushConnect } from '@/lib/push/login-routes';

/**
 * POST /api/member/push/connect { platform, osPushToken } -> { ticket,
 * relayUrl }: the Connect step for a MEMBER login's phone (migration 0211,
 * docs/mobile-companion-backend.md "Three roles on the phone"). The app takes
 * the ticket to the relay's /enroll, then posts the routing token to
 * /api/member/push/subscriptions. A member may
 * be the one who registers this brain with the relay (the first Connect).
 */
export async function POST(req: Request) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  return loginPushConnect(req, member);
}
