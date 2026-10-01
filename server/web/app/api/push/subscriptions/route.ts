// /api/push/subscriptions
//   POST — store a device the app just enrolled with the relay (routing token +
//          public key). Called after the app's /enroll round-trip.
//   GET  — list the brain's admin devices (metadata only; for settings). A
//          member's or a client's device is its own login's business
//          (/api/member/push, /api/client/push) and is not listed here.

import { type NextRequest, NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { callerTokenId, pushEnrolLimited } from '@/lib/push/login-routes';
import { forgetRelayDevices, insertSubscription, listAdminDeviceList } from '@/lib/push/store';

export async function POST(req: NextRequest) {
  const owner = await getOwnerOr401();
  if (owner instanceof NextResponse) return owner;
  const limited = pushEnrolLimited(owner.actor.id);
  if (limited) return limited;
  // The phone app always signs in with a device token, and a device is
  // pushed to only while that token is live: an enrol with no bearer of this
  // login (a browser session) would make a device nothing can revoke.
  const tokenId = await callerTokenId(req, owner.actor.id);
  if (!tokenId) return NextResponse.json({ error: 'bearer_required' }, { status: 400 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const routingToken = body?.['routingToken'];
  const publicKey = body?.['publicKey'];
  const platform = body?.['platform'];
  if (
    typeof routingToken !== 'string' ||
    typeof publicKey !== 'string' ||
    (platform !== 'ios' && platform !== 'android')
  ) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  const label = typeof body?.['label'] === 'string' ? (body['label'] as string) : null;
  const relayDeviceId =
    typeof body?.['deviceId'] === 'string' ? (body['deviceId'] as string) : null;

  const { id, dropped } = await insertSubscription({
    ownerId: owner.id,
    // The login, not the brain: locking this login out unpairs the device.
    loginId: owner.actor.id,
    // The device token it signed in with: revoking that device, a sign-out
    // or End sessions stops its pushes too.
    tokenId,
    routingToken,
    publicKey,
    platform,
    label,
    relayDeviceId,
  });
  // Devices over the cap were dropped (the oldest): tell the relay.
  await forgetRelayDevices(dropped);
  return NextResponse.json({ id });
}

export async function GET() {
  const owner = await getOwnerOr401();
  if (owner instanceof NextResponse) return owner;
  const devices = await listAdminDeviceList(owner.id);
  // Don't leak routing tokens / public keys to the list view.
  return NextResponse.json({
    devices: devices.map((d) => ({ id: d.id, platform: d.platform, label: d.label })),
  });
}
