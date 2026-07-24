// /api/push/subscriptions
//   POST — store a device the app just enrolled with the relay (routing token +
//          public key). Called after the app's /enroll round-trip.
//   GET  — list this owner's enrolled devices (metadata only; for settings).

import { type NextRequest, NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { insertSubscription, listSubscriptions } from '@/lib/push/store';

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
  const devices = await listSubscriptions(owner.id);
  // Don't leak routing tokens / public keys to the list view.
  return NextResponse.json({
    devices: devices.map((d) => ({ id: d.id, platform: d.platform, label: d.label })),
  });
}
