import { NextResponse } from '@/server/http-compat';
import { recordAppAccess } from '@mantle/content';
import { buildAppFrameTicket, getMemberOr401 } from '@/lib/auth';
import { memberAppOr404 } from '@/lib/member-apps';
import { rateLimit } from '@/lib/rate-limit';

/**
 * POST /api/member/apps/:id/frame-ticket: the seconds-lived ticket the
 * sandbox iframe presents to GET /api/member/apps/:id/frame (member logins
 * Phase 4b). The member authenticates HERE; the frame navigation carries only
 * the ticket. The ticket names the login (`mem`), so the owner frame route,
 * which serves drafts, refuses it. 404 unless the member may run the app.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  // One ticket per frame load; a burst beyond this is a token-mint loop.
  const gate = rateLimit(`member-frame-ticket:${member.loginId}`, { max: 30, windowMs: 60_000 });
  if (!gate.ok) {
    return NextResponse.json(
      { ok: false, error: 'too many requests' },
      { status: 429, headers: { 'retry-after': String(gate.retryAfterSec) } },
    );
  }
  const { id } = await ctx.params;
  const app = await memberAppOr404(member.anchorId, id, member.loginId);
  if (app instanceof Response) return app;
  recordAppAccess({
    ownerId: app.ownerId,
    appNodeId: app.id,
    actorId: member.loginId,
    kind: 'auth',
    detail: { via: 'member' },
  });
  return NextResponse.json({
    ticket: buildAppFrameTicket({
      ownerId: member.anchorId,
      appId: app.id,
      loginId: member.loginId,
    }),
  });
}
