/**
 * POST /api/gateway/calls (docs/gateway.md): a batch of the service
 * gateway's call rows, from the gateway itself (its token, straight from
 * the stack's network: lib/gateway-internal.ts). Written in one statement;
 * the reap of rows past 90 days rides along at most once an hour.
 */
import { NextResponse } from '@/server/http-compat';
import { gatewayCallBatch, insertGatewayCalls } from '@mantle/db';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';
import { gatewayRequestRefusal, reapGatewayCallsSoon } from '@/lib/gateway-internal';

export const policy = routePolicy({
  // No rate limit, as the registry route (registry/route.ts says why).
  POST: {
    class: 'public',
    item: { none: "a public route: it judges its own credential (the gateway's token)" },
  },
});

export async function POST(req: Request) {
  const refused = gatewayRequestRefusal(req);
  if (refused) return refused;
  const batch = gatewayCallBatch(await readJson(req));
  if (!batch) return NextResponse.json({ error: 'send { calls: [...] }' }, { status: 400 });
  const written = await insertGatewayCalls(batch);
  reapGatewayCallsSoon();
  return NextResponse.json({ written });
}
