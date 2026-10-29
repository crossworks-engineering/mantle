/**
 * GET /api/apps/[id]/frame: the sandbox frame document. Auth is the `?t=`
 * frame ticket minted by POST /api/apps/[id]/frame-ticket (the sandboxed
 * iframe's navigation carries no other credential); the middleware gate
 * admits this path on a valid kind-'f' token and the route re-verifies.
 *
 * An owner ticket (an Admin user's) serves the DRAFT build when present
 * (preview of unpublished work), else the published build: the same choice as
 * /bundle. A member ticket (every login runs apps here) serves the
 * PUBLISHED build of an app the member's workspaces hold, after re-checking
 * the login (lib/app-runner.ts).
 *
 * An owner ticket opens the frame only while the login it names (`act`) is
 * an active Admin user, re-read here as the member frame re-reads its
 * member: a ticket that names a client, a member, a
 * disabled login or nobody is refused, so no non-Admin login reaches the
 * draft through it. A client's own ticket (`cep`) is refused.
 *
 * The ticket is the caller the gate answers (frameTicketCaller): the `?t=` verified, or null. What it may open is checked here.
 */
import { NextResponse } from '@/server/http-compat';
import { adminLoginActive, frameTicketCaller } from '@/lib/auth';
import { getAppRuntime } from '@mantle/content';
import { renderAppFrame } from '@/lib/app-frame';
import { isMemberFrameTicket, memberFrame } from '@/lib/app-runner';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'content', caller: 'frame' },
});

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const ticket = frameTicketCaller();
  const { id } = await ctx.params;
  if (ticket && isMemberFrameTicket(ticket, id)) return memberFrame(req, id, ticket);
  // Any other login ticket (a client's), a share-scoped ticket or a review
  // test ticket must not open the owner frame: this route serves the
  // owner's DRAFT.
  if (!ticket || ticket.appId !== id || ticket.shareId || ticket.loginId || ticket.reviewTest) {
    return new NextResponse('frame ticket required', { status: 401 });
  }
  if (!ticket.actorId || !(await adminLoginActive(ticket.actorId))) {
    return new NextResponse('admin session required', { status: 401 });
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
    viewer: {
      ownerId: ticket.ownerId,
      appId: id,
      subject: { kind: 'admin', loginId: ticket.actorId },
    },
  });
}
