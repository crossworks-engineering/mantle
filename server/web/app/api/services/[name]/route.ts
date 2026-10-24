import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { auditFireAndForget, requestMeta } from '@/lib/audit';
import { isOptionalService, requestServiceSwitch } from '@/lib/services';
import { readBody } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'area',
    area: 'settings',
    item: { none: 'manages the settings area: the Admin step checks it' },
    audit: 'own',
  },
});

const Body = z.object({ enable: z.boolean() }).strict();

/**
 * POST /api/services/:name {enable} — switch an optional service (sandboxes,
 * media, local-embedder, helpers) on or off. Admin logins only (the roll's gate); members, clients
 * and agents have no path here. Writes its own `service.toggle` audit row
 * (its declaration says `audit: 'own'`) with the outcome of the request.
 * A refusal (no updater, a roll running) is a 200 `{ok:false,error}` so the
 * client can show it, like /api/updates/request.
 */
export async function POST(req: Request, { params }: { params: Promise<{ name: string }> }) {
  const user = ownerCaller();
  const { name } = await params;
  if (!isOptionalService(name)) {
    return NextResponse.json({ error: `unknown service '${name}'` }, { status: 404 });
  }
  const body = await readBody(req, Body);
  const result = await requestServiceSwitch(name, body.enable);
  auditFireAndForget({
    actorId: user.actor.id,
    actorEmail: user.actor.email,
    action: 'service.toggle',
    method: 'POST',
    path: `/api/services/${name}`,
    detail: {
      service: name,
      enable: body.enable,
      accepted: result.ok,
      ...(result.ok ? {} : { refused: result.error }),
    },
    ...(await requestMeta()),
  });
  return NextResponse.json(result);
}
