import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { auditFireAndForget, requestMeta } from '@/lib/audit';
import { isOptionalService, requestServiceSwitch } from '@/lib/services';
import { firstIssue } from '@/lib/zod-issue';

const Body = z.object({ enable: z.boolean() }).strict();

/**
 * POST /api/services/:name {enable} — switch an optional service (sandboxes,
 * media) on or off. Admin logins only (the roll's gate); members, clients
 * and agents have no path here. Writes its own `service.toggle` audit row
 * (the path is in AUDIT_SELF_LOGGED_PATHS) with the outcome of the request.
 * A refusal (no updater, a roll running) is a 200 `{ok:false,error}` so the
 * client can show it, like /api/updates/request.
 */
export async function POST(req: Request, { params }: { params: Promise<{ name: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { name } = await params;
  if (!isOptionalService(name)) {
    return NextResponse.json({ error: `unknown service '${name}'` }, { status: 404 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  const result = await requestServiceSwitch(name, parsed.data.enable);
  auditFireAndForget({
    actorId: user.actor.id,
    actorEmail: user.actor.email,
    action: 'service.toggle',
    method: 'POST',
    path: `/api/services/${name}`,
    detail: {
      service: name,
      enable: parsed.data.enable,
      accepted: result.ok,
      ...(result.ok ? {} : { refused: result.error }),
    },
    ...(await requestMeta()),
  });
  return NextResponse.json(result);
}
