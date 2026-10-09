/**
 * POST /api/apps/members/:id/test/frame-ticket: the seconds-lived ticket the
 * sandbox iframe presents to GET .../test/frame, for an admin's test run of a
 * member's app. The admin authenticates HERE. The ticket is a review test
 * ticket (`rv`): only the test frame accepts it, and it never opens the
 * owner frame (which serves drafts) or any other. 404 for an app an admin
 * may not reach or one with no published build.
 */
import { NextResponse } from '@/server/http-compat';
import { buildAppFrameTicket, getOwnerOr401 } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { reviewAppOr404 } from '@/lib/review-apps';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const gate = rateLimit(`review-test-ticket:${user.actor.id}`, { max: 30, windowMs: 60_000 });
  if (!gate.ok) {
    return NextResponse.json(
      { ok: false, error: 'too many requests' },
      { status: 429, headers: { 'retry-after': String(gate.retryAfterSec) } },
    );
  }
  const app = await reviewAppOr404((await ctx.params).id);
  if (app instanceof Response) return app;
  if (!app.runnable) return new NextResponse('no build', { status: 404 });
  return NextResponse.json({
    ticket: buildAppFrameTicket({
      ownerId: user.id,
      appId: app.id,
      actorId: user.actor.id,
      reviewTest: true,
    }),
  });
}
