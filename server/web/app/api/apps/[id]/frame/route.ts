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
import { getApp } from '@mantle/content';
import { renderAppFrame } from '@/lib/app-frame';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const t = new URL(req.url).searchParams.get('t');
  const ticket = t ? verifyAppFrameTicket(t) : null;
  // A share-scoped ticket (`shareId` set) must not open the owner frame — it
  // was minted against a share's published build, not the owner's draft.
  if (!ticket || ticket.appId !== id || ticket.shareId) {
    return new NextResponse('frame ticket required', { status: 401 });
  }

  const app = await getApp(ticket.ownerId, id);
  if (!app) return new NextResponse('not found', { status: 404 });
  const build = app.draftBuild?.ok
    ? app.draftBuild
    : app.publishedBuild?.ok
      ? app.publishedBuild
      : null;
  if (!build) return new NextResponse('no build', { status: 404 });

  return renderAppFrame(req, build);
}
