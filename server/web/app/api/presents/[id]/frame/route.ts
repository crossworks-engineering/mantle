/**
 * GET /api/presents/[id]/frame: a canvas's sandbox frame document
 * (docs/proposals/canvas-files.md 5.2). Auth is the `?t=` canvas frame
 * ticket from POST .../frame-ticket; the gate admits this path on a valid
 * frame ticket and the caller is that ticket, verified as a CANVAS ticket
 * (an app's is refused). What it may open is checked here:
 *
 *  - the ticket names this canvas;
 *  - an Admin user's ticket: the login is still an active Admin user;
 *  - a member's ticket: the login is still an active member, and the canvas
 *    is still one it reads (read again in its own scope).
 *
 * The latest save is served (latest is latest). No bridge: the document can
 * post `ready` and `error` to its parent and nothing else.
 */
import { NextResponse } from '@/server/http-compat';
import { withViewer } from '@mantle/db';
import { adminLoginActive, frameTicketCaller, memberLoginActive } from '@/lib/auth';
import { getPresentFrame } from '@/lib/presents';
import { renderCanvasFrame } from '@/lib/canvas-frame';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const ticket = frameTicketCaller();
  const { id } = await ctx.params;
  if (!ticket?.canvas || ticket.appId !== id.toLowerCase() || ticket.shareId) {
    return new NextResponse('frame ticket required', { status: 401 });
  }
  let canvas: Awaited<ReturnType<typeof getPresentFrame>>;
  if (ticket.actorId) {
    if (!(await adminLoginActive(ticket.actorId))) {
      return new NextResponse('admin session required', { status: 401 });
    }
    canvas = await getPresentFrame(ticket.ownerId, id);
  } else if (ticket.loginId && ticket.clientEpoch === undefined) {
    const loginId = ticket.loginId;
    if (!(await memberLoginActive(loginId))) {
      return new NextResponse('member session required', { status: 401 });
    }
    canvas = await withViewer({ login: loginId }, () => getPresentFrame(ticket.ownerId, id));
  } else {
    return new NextResponse('frame ticket required', { status: 401 });
  }
  if (!canvas) return new NextResponse('not found', { status: 404 });
  return renderCanvasFrame(req, ticket.ownerId, canvas);
}
