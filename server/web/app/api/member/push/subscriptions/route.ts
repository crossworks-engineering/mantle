import { memberCaller } from '@/lib/auth';
import { loginPushDevices, loginPushSubscribe } from '@/lib/push/login-routes';

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
