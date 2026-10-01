// POST /api/push/connect — the one-tap Connect entrypoint (push-notifications.md
// §5.1). Lazily generates + registers this install's instance token with the
// relay (first time only), then mints a short-lived enrollment ticket bound to
// the calling device's OS push token. The app takes the ticket to the relay's
// /enroll, then posts the routing token back to /api/push/subscriptions.

import { type NextRequest, NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { connectDevice, parseConnectBody } from '@/lib/push/connect';

export async function POST(req: NextRequest) {
  const owner = await getOwnerOr401();
  if (owner instanceof NextResponse) return owner;

  const body = parseConnectBody(await req.json().catch(() => null));
  if (!body) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  const res = await connectDevice(body.osPushToken, { mayRegister: true });
  if (!res.ok) {
    return NextResponse.json(
      { error: 'relay_unreachable', reason: res.error === 'relay_unreachable' ? res.reason : '' },
      { status: 502 },
    );
  }
  return NextResponse.json({ ticket: res.ticket, relayUrl: res.relayUrl });
}
