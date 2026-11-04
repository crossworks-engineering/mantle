/**
 * GET /api/gateway/registry (docs/gateway.md): the services the service
 * gateway may route to, for the gateway itself (its token, straight from
 * the stack's network: lib/gateway-internal.ts). Only what routing needs:
 * slug, upstream, paths, methods, switch. The gateway keeps it a few
 * seconds and refuses every call when it cannot read it.
 */
import { NextResponse } from '@/server/http-compat';
import { listGatewayServices, runAsActor, systemActor } from '@mantle/db';
import { routePolicy } from '@/lib/auth/route-declaration';
import { gatewayRequestRefusal } from '@/lib/gateway-internal';

export const policy = routePolicy({
  // No rate limit: a limit keyed on the address would put every direct
  // caller in one bucket, so a stranger without the token could use it up
  // and starve the gateway. The token (256 bits) is checked first and a
  // refusal does no work.
  GET: { class: 'public' },
});

const READER = systemActor('gateway:route');

export async function GET(req: Request) {
  const refused = gatewayRequestRefusal(req);
  if (refused) return refused;
  const rows = await runAsActor(READER, () => listGatewayServices());
  return NextResponse.json({
    services: rows.map((r) => ({
      slug: r.slug,
      upstream: r.upstream,
      pathPrefixes: r.pathPrefixes,
      methods: r.methods,
      enabled: r.enabled,
    })),
  });
}
