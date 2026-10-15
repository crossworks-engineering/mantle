// POST /api/push/connect — the one-tap Connect entrypoint (push-notifications.md
// §5.1). Lazily generates + registers this install's instance token with the
// relay (first time only), then mints a short-lived enrollment ticket bound to
// the calling device's OS push token. The app takes the ticket to the relay's
// /enroll, then posts the routing token back to /api/push/subscriptions.

import { type NextRequest, NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { connectDevice, parseConnectBody } from '@/lib/push/connect';
import { readJson } from '@/lib/read-body';

export async function POST(req: NextRequest) {
  // The owner the gate answered (read, so the row reads it: the caller
  // the gate answers, and the login its limit counts). The gate took the
  // row's per-login limit (lib/route-limits.ts pushEnrol).
  ownerCaller();

  const body = parseConnectBody(await readJson(req, { empty: null }));
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
