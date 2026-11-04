import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { getGatewayService, listGatewayCalls, setGatewayService } from '@mantle/db';
import { readBody } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';
import { gatewayCallOut, gatewayServiceOut } from '@/lib/gateway-services';

export const policy = routePolicy({
  GET: { class: 'area', area: 'connectors' },
  PATCH: {
    class: 'area',
    area: 'connectors',
    item: { none: 'manages the connectors area: the Admin step checks it' },
  },
});

/** One gateway service (docs/gateway.md): GET it with its newest calls;
 *  PATCH edits it or switches it off (`{ "enabled": false }`). */

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  ownerCaller();
  const { slug } = await params;
  const service = await getGatewayService(slug);
  if (!service) {
    return NextResponse.json({ error: 'no gateway service has that slug' }, { status: 404 });
  }
  const calls = await listGatewayCalls({ slug, limit: 50 });
  return NextResponse.json({
    service: gatewayServiceOut(service),
    calls: calls.map(gatewayCallOut),
  });
}

const PatchBody = z.object({
  name: z.string().min(1).max(120).optional(),
  upstream: z.string().min(1).max(200).optional(),
  pathPrefixes: z.array(z.string().max(200)).min(1).max(20).optional(),
  methods: z.array(z.string().max(16)).min(1).max(7).optional(),
  readsOnly: z.boolean().optional(),
  enabled: z.boolean().optional(),
  note: z.string().max(500).nullable().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const user = ownerCaller();
  const { slug } = await params;
  const patch = await readBody(req, PatchBody);
  if (!(await getGatewayService(slug))) {
    return NextResponse.json({ error: 'no gateway service has that slug' }, { status: 404 });
  }
  const res = await setGatewayService(slug, patch, user.actor.id);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json({ service: gatewayServiceOut(res.row) });
}
