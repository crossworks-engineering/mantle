import { NextResponse } from '@/server/http-compat';
import { recordAppAccess } from '@mantle/content';
import { buildAppFrameTicket, getClientOr401 } from '@/lib/auth';
import { clientAppOr404 } from '@/lib/client-apps';
import { rateLimit } from '@/lib/rate-limit';

/**
 * POST /api/client/apps/:id/frame-ticket: the seconds-lived ticket the
 * sandbox iframe presents to GET /api/client/apps/:id/frame (client logins
 * C6). The client authenticates HERE; the frame navigation carries only the
 * ticket. The ticket names the login AND its session epoch, so the frame
 * refuses it once the client signs out, an admin ends its sessions or
 * disables it. Only the client frame route accepts it (the owner, member and
 * share frames refuse a login ticket or a client one). 404 unless the client
 * may run the app.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const client = await getClientOr401();
  if (client instanceof Response) return client;
  // One ticket per frame load; a burst beyond this is a token-mint loop.
  const gate = rateLimit(`client-frame-ticket:${client.loginId}`, { max: 30, windowMs: 60_000 });
  if (!gate.ok) {
    return NextResponse.json(
      { ok: false, error: 'too many requests' },
      { status: 429, headers: { 'retry-after': String(gate.retryAfterSec) } },
    );
  }
  const { id } = await ctx.params;
  const app = await clientAppOr404(client.anchorId, id);
  if (app instanceof Response) return app;
  recordAppAccess({
    ownerId: client.anchorId,
    appNodeId: app.id,
    actorId: client.loginId,
    kind: 'auth',
    detail: { via: 'client' },
  });
  return NextResponse.json({
    ticket: buildAppFrameTicket({
      ownerId: client.anchorId,
      appId: app.id,
      loginId: client.loginId,
      clientEpoch: client.sessionEpoch,
    }),
  });
}
