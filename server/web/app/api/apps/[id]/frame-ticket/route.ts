/**
 * POST /api/apps/[id]/frame-ticket — mint the seconds-lived signed ticket the
 * sandbox iframe presents to GET /api/apps/[id]/frame (an iframe navigation
 * carries no cookie — the frame is sandboxed without allow-same-origin — and
 * no bearer, so THIS session-authed call is where the owner authenticates).
 * 404 when the app has never built green, so the sandbox can show its
 * "hasn't been built yet" state without navigating anywhere.
 */
import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401, buildAppFrameTicket } from '@/lib/auth';
import { getApp } from '@mantle/content';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const app = await getApp(user.id, id);
  if (!app) return new NextResponse('not found', { status: 404 });

  const build = app.draftBuild?.ok
    ? app.draftBuild
    : app.publishedBuild?.ok
      ? app.publishedBuild
      : null;
  if (!build) return new NextResponse('no build', { status: 404 });

  return NextResponse.json({ ticket: buildAppFrameTicket({ ownerId: user.id, appId: id }) });
}
