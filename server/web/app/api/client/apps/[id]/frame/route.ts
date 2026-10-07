import { NextResponse } from '@/server/http-compat';
import { clientLoginActive, verifyAppFrameTicket } from '@/lib/auth';
import { renderAppFrame } from '@/lib/app-frame';
import { clientAppOr404 } from '@/lib/client-apps';

/**
 * GET /api/client/apps/:id/frame: the sandbox frame document for a CLIENT's
 * run of an app (client logins C6). Auth is the `?t=` ticket from
 * POST /api/client/apps/:id/frame-ticket (a sandboxed iframe sends no
 * cookie); the gate admits this path on a kind 'f' ticket and this route
 * re-verifies. Only a CLIENT ticket opens it, for this app, while the login
 * is still an enabled client at the session epoch the ticket was minted
 * under (Sign out, End sessions and Disable all end it), and the app is
 * still one clients may run. PUBLISHED build only, never the draft.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const t = new URL(req.url).searchParams.get('t');
  const ticket = t ? verifyAppFrameTicket(t) : null;
  // The ticket carries the app id as stored (lower case).
  if (
    !ticket?.loginId ||
    ticket.clientEpoch === undefined ||
    ticket.shareId ||
    ticket.appId !== id.toLowerCase()
  ) {
    return new NextResponse('frame ticket required', { status: 401 });
  }
  // Liveness: the ticket proves who the client WAS at mint time.
  if (!(await clientLoginActive(ticket.loginId, ticket.clientEpoch))) {
    return new NextResponse('client session required', { status: 401 });
  }
  const app = await clientAppOr404(ticket.ownerId, id);
  if (app instanceof Response) return new NextResponse('not found', { status: 404 });
  return renderAppFrame(req, app.publishedBuild, {
    viewer: {
      ownerId: ticket.ownerId,
      appId: app.id,
      subject: { kind: 'client', loginId: ticket.loginId },
    },
  });
}
