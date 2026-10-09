/**
 * POST   /api/apps/members/:id/test: start (or restart) the admin's test run
 *        of a member's app, on a fresh THROWAWAY COPY of its data
 *        (@mantle/content/app-review-test). The member's real file is only
 *        read. 404 for an app an admin may not reach, 409 when it has no
 *        published build to run.
 * DELETE /api/apps/members/:id/test: end it; the copy goes. The admin's app
 *        screen sends this when the admin leaves; an idle copy goes by
 *        itself after REVIEW_TEST_IDLE_MS.
 */
import { NextResponse } from '@/server/http-compat';
import { endReviewTest, startReviewTest } from '@mantle/content/app-review-test';
import { getOwnerOr401 } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { reviewAppOr404, reviewTester } from '@/lib/review-apps';
import { spaceAppId, spaceAppNotFound } from '@/lib/space-apps';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  // Each start copies the app's whole database: bounded per login.
  const gate = rateLimit(`review-test-start:${user.actor.id}`, { max: 10, windowMs: 60_000 });
  if (!gate.ok) {
    return NextResponse.json(
      { ok: false, error: 'too many requests' },
      { status: 429, headers: { 'retry-after': String(gate.retryAfterSec) } },
    );
  }
  const app = await reviewAppOr404((await ctx.params).id);
  if (app instanceof Response) return app;
  if (!app.runnable) {
    return NextResponse.json(
      { ok: false, error: 'This app has no published build to test yet.', reason: 'no-build' },
      { status: 409 },
    );
  }
  const res = await startReviewTest(reviewTester(user), app);
  return NextResponse.json({ ok: true, ...res });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const id = spaceAppId((await ctx.params).id);
  if (!id) return spaceAppNotFound();
  // Ending a test needs no reach: it removes only this admin's own copy.
  await endReviewTest(user.actor.id, id);
  return NextResponse.json({ ok: true });
}
