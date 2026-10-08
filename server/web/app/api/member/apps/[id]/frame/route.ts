import { NextResponse } from '@/server/http-compat';
import { memberLoginActive, verifyAppFrameTicket } from '@/lib/auth';
import { renderAppFrame } from '@/lib/app-frame';
import { memberAppOr404 } from '@/lib/member-apps';

/**
 * GET /api/member/apps/:id/frame: the sandbox frame document for a MEMBER's
 * run of an app (member logins Phase 4b). Auth is the `?t=` ticket from
 * POST /api/member/apps/:id/frame-ticket (a sandboxed iframe sends no cookie);
 * the gate admits this path on a kind 'f' ticket and this route re-verifies.
 * Only a member ticket opens it, for this app, while the login is still an
 * active member and the app still one they may run. PUBLISHED build only,
 * never the draft.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const t = new URL(req.url).searchParams.get('t');
  const ticket = t ? verifyAppFrameTicket(t) : null;
  // The ticket carries the app id as stored (lower case).
  // A client's ticket (it carries `clientEpoch`) never opens a member frame.
  if (
    !ticket?.loginId ||
    ticket.clientEpoch !== undefined ||
    ticket.shareId ||
    ticket.appId !== id.toLowerCase()
  ) {
    return new NextResponse('frame ticket required', { status: 401 });
  }
  // Liveness: the ticket proves who the member WAS at mint time.
  if (!(await memberLoginActive(ticket.loginId))) {
    return new NextResponse('member session required', { status: 401 });
  }
  const app = await memberAppOr404(ticket.ownerId, id, ticket.loginId);
  if (app instanceof Response) return new NextResponse('not found', { status: 404 });
  return renderAppFrame(req, app.publishedBuild, {
    viewer: {
      // The owner the app's rows are keyed to: the author's space for a
      // member-built app (team apps Phase 3).
      ownerId: app.ownerId,
      appId: app.id,
      subject: { kind: 'member', loginId: ticket.loginId },
    },
  });
}
