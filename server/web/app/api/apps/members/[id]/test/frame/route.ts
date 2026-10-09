/**
 * GET /api/apps/members/:id/test/frame: the sandbox frame document for an
 * admin's TEST run of a member's app. Auth is the `?t=` review test ticket
 * from POST .../test/frame-ticket (the gate admits this path on a kind 'f'
 * ticket; this route re-verifies). Only a review test ticket opens it, for
 * this app, while the ticket's admin is still an active admin and the app
 * still one an admin may reach. PUBLISHED build only, never the draft.
 * host.me() is the admin, resolved without touching the real app's registry.
 */
import { NextResponse } from '@/server/http-compat';
import { reviewTestViewer } from '@mantle/content/app-review-test';
import { adminLoginActive, verifyAppFrameTicket } from '@/lib/auth';
import { renderAppFrame } from '@/lib/app-frame';
import { reviewAppOr404 } from '@/lib/review-apps';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const t = new URL(req.url).searchParams.get('t');
  const ticket = t ? verifyAppFrameTicket(t) : null;
  if (
    !ticket?.reviewTest ||
    !ticket.actorId ||
    ticket.shareId ||
    ticket.loginId ||
    ticket.appId !== id.toLowerCase()
  ) {
    return new NextResponse('frame ticket required', { status: 401 });
  }
  if (!(await adminLoginActive(ticket.actorId))) {
    return new NextResponse('admin session required', { status: 401 });
  }
  const app = await reviewAppOr404(id);
  if (app instanceof Response || !app.publishedBuild?.ok) {
    return new NextResponse('not found', { status: 404 });
  }
  // The name is looked up, as every test statement looks it up, so host.me()
  // and :host_me_name agree.
  const viewer = await reviewTestViewer({ loginId: ticket.actorId }, app);
  return renderAppFrame(req, app.publishedBuild, { resolvedViewer: viewer });
}
