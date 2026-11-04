import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { listGatewayCalls, listGatewayServices, setGatewayService } from '@mantle/db';
import { readBody } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';
import { gatewayCallOut, gatewayServiceOut } from '@/lib/gateway-services';

export const policy = routePolicy({
  GET: { class: 'area', area: 'connectors' },
  POST: {
    class: 'area',
    area: 'connectors',
    item: { none: 'manages the connectors area: the Admin step checks it' },
  },
});

/** The service gateway's registry (docs/gateway.md): GET lists the box
 *  services the gateway may route to and its newest calls; POST registers a
 *  service or sets the fields it names of the one with its slug. The
 *  checks are @mantle/db service-gateway.ts's, the same as the MCP tool
 *  gateway_service_set. */

export async function GET() {
  ownerCaller();
  const [services, calls] = await Promise.all([
    listGatewayServices(),
    listGatewayCalls({ limit: 50 }),
  ]);
  return NextResponse.json({
    services: services.map(gatewayServiceOut),
    calls: calls.map(gatewayCallOut),
  });
}

const SetBody = z.object({
  slug: z.string().min(1).max(40),
  name: z.string().min(1).max(120).optional(),
  upstream: z.string().min(1).max(200).optional(),
  pathPrefixes: z.array(z.string().max(200)).min(1).max(20).optional(),
  methods: z.array(z.string().max(16)).min(1).max(7).optional(),
  readsOnly: z.boolean().optional(),
  enabled: z.boolean().optional(),
  note: z.string().max(500).nullable().optional(),
});

export async function POST(req: Request) {
  const user = ownerCaller();
  const body = await readBody(req, SetBody);
  const { slug, ...patch } = body;
  const res = await setGatewayService(slug, patch, user.actor.id);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json(
    { created: res.created, service: gatewayServiceOut(res.row) },
    { status: res.created ? 201 : 200 },
  );
}
