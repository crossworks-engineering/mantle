import { memberCaller } from '@/lib/auth';
import { loginPushDevices, loginPushSubscribe } from '@/lib/push/login-routes';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'self', open: 'member' },
  POST: {
    class: 'self',
    open: 'member',
    item: { none: "the login's own things, not an item" },
    limits: { rateLimit: ['pushEnrol'] },
  },
});

/**
 * /api/member/push/subscriptions (a MEMBER login's own devices, mobile_roles_push)
 *   POST { routingToken, publicKey, platform, label?, deviceId? } -> { id }
 *        store the device the app just enrolled with the relay. Needs the
 *        app's bearer (400 `bearer_required` otherwise): the device is
 *        pushed to only while that token is live.
 *   GET  -> { devices: [{ id, platform, label, current }] }: this login's
 *        devices, metadata only.
 */
export async function POST(req: Request) {
  const member = memberCaller();
  return loginPushSubscribe(req, member);
}

export async function GET(req: Request) {
  const member = memberCaller();
  return loginPushDevices(req, member);
}
