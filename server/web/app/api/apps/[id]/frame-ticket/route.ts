/**
 * POST /api/apps/[id]/frame-ticket — mint the seconds-lived signed ticket the
 * sandbox iframe presents to GET /api/apps/[id]/frame (an iframe navigation
 * carries no cookie — the frame is sandboxed without allow-same-origin — and
 * no bearer, so THIS session-authed call is where the login authenticates).
 * 404 when the app has never built green, so the sandbox can show its
 * "hasn't been built yet" state without navigating anywhere.
 *
 * Every login since W7e: an Admin user gets the owner ticket (draft build
 * allowed, as before); a member a member ticket for an app its workspaces
 * hold, published build only (lib/app-runner.ts). An app the member does not
 * read is a 404. A client login is refused (403 client-login): clients do
 * not run brain apps, and it must never reach the owner ticket below.
 */
import { NextResponse } from '@/server/http-compat';
import { buildAppFrameTicket, ownerLoginCaller } from '@/lib/auth';
import { adminFacts } from '@/lib/auth/login';
import { getAppRuntime } from '@mantle/content';
import { memberFrameTicket } from '@/lib/app-runner';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

/** The ids are uuids: any other names nothing, the params gateway's one
 *  404 before the handler (lib/route-params.ts; the item gate answered it
 *  until the pre-check removal part 2). */
export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  POST: {
    class: 'content',
    open: 'owner',
    makesItems: false,
    item: { none: 'not decided yet: the write names an item no check reads' },
    limits: { rateLimit: ['memberFrameTicket'] },
  },
});

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const login = ownerLoginCaller();
  const { id } = await ctx.params;
  // A login that is not an Admin user (adminFacts) runs the published build.
  if (!(await adminFacts(login)).admin) return memberFrameTicket(login, id);
  const user = { id: login.brainId, actor: login.actor };
  const app = await getAppRuntime(user.id, id);
  if (!app) return new NextResponse('not found', { status: 404 });

  const build = app.draftBuild?.ok
    ? app.draftBuild
    : app.publishedBuild?.ok
      ? app.publishedBuild
      : null;
  if (!build) return new NextResponse('no build', { status: 404 });

  // The ticket names the admin login, so the frame can answer host.me().
  return NextResponse.json({
    ticket: buildAppFrameTicket({ ownerId: user.id, appId: id, actorId: user.actor.id }),
  });
}
