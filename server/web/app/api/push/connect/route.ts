// POST /api/push/connect — the one-tap Connect entrypoint (push-notifications.md
// §5.1). Lazily generates + registers this install's instance token with the
// relay (first time only), then mints a short-lived enrollment ticket bound to
// the calling device's OS push token. The app takes the ticket to the relay's
// /enroll, then posts the routing token back to /api/push/subscriptions.

import { type NextRequest, NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { connectDevice, parseConnectBody } from '@/lib/push/connect';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'self',
    item: { none: "the login's own things, not an item" },
    limits: { rateLimit: ['pushEnrol'] },
  },
});

export async function POST(req: NextRequest) {
  // A bare read, its value unused: it is here for the route manifest only.
  // The generator (scripts/route-callers.ts) finds the
  // reader and gives the row its caller, 'owner', which the gate answers
  // and whose login the row's per-login limit counts (lib/route-limits.ts
  // pushEnrol). Without it the row reads no caller, which buildRoutePolicy
  // refuses for a row that is not public. The handler itself needs no
  // owner: the relay ticket is the install's, not a login's.
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
