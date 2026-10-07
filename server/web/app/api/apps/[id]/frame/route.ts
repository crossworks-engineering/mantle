/**
 * GET /api/apps/[id]/frame — the OWNER-surface sandbox frame document. Auth is
 * the `?t=` frame ticket minted by POST /api/apps/[id]/frame-ticket (the
 * sandboxed iframe's navigation carries no other credential); the middleware
 * gate admits this path on a valid kind-'f' token and the route re-verifies.
 * Serves the DRAFT build when present (preview of unpublished work), else the
 * published build — same choice as /bundle.
 */
import { NextResponse } from '@/server/http-compat';
import { verifyAppFrameTicket } from '@/lib/auth';
import { getAppRuntime } from '@mantle/content';
import { renderAppFrame } from '@/lib/app-frame';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const t = new URL(req.url).searchParams.get('t');
  const ticket = t ? verifyAppFrameTicket(t) : null;
  // A share-scoped ticket (`shareId` set) or a member's (`loginId` set) must
  // not open the owner frame: it was minted for a published build, and this
  // route serves the owner's DRAFT.
  if (!ticket || ticket.appId !== id || ticket.shareId || ticket.loginId) {
    return new NextResponse('frame ticket required', { status: 401 });
  }

  const app = await getAppRuntime(ticket.ownerId, id);
  if (!app) return new NextResponse('not found', { status: 404 });
  const build = app.draftBuild?.ok
    ? app.draftBuild
    : app.publishedBuild?.ok
      ? app.publishedBuild
      : null;
  if (!build) return new NextResponse('no build', { status: 404 });

  // host.me(): the admin login the ticket names (app identity).
  return renderAppFrame(req, build, {
    viewer: ticket.actorId
      ? { ownerId: ticket.ownerId, appId: id, subject: { kind: 'admin', loginId: ticket.actorId } }
      : undefined,
  });
}
