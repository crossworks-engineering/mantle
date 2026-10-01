// /api/push/subscriptions
//   POST — store a device the app just enrolled with the relay (routing token +
//          public key). Called after the app's /enroll round-trip.
//   GET  — list the brain's admin devices (metadata only; for settings). A
//          member's or a client's device is its own login's business
//          (/api/member/push, /api/client/push) and is not listed here.

import { type NextRequest, NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { callerTokenId } from '@/lib/push/login-routes';
import { insertSubscription, listAdminDeviceList } from '@/lib/push/store';

export async function POST(req: NextRequest) {
  const owner = await getOwnerOr401();
  if (owner instanceof NextResponse) return owner;

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

  const { id } = await insertSubscription({
    ownerId: owner.id,
    // The login, not the brain: locking this login out unpairs the device.
    loginId: owner.actor.id,
    // The device token it signed in with (mobile_roles_push), when it did so by bearer:
    // revoking that device then stops its pushes too.
    tokenId: await callerTokenId(req, owner.actor.id),
    routingToken,
    publicKey,
    platform,
    label,
    relayDeviceId,
  });
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
