/**
 * POST /api/apps/members/:id/test/db-broker: host.db.query / host.db.exec of
 * an admin's TEST run of a member's app. Every statement runs on the admin's
 * throwaway copy (@mantle/content/app-review-test), never on the member's
 * database: no registry write, no table export, nothing real changes. Writes
 * change rows only, at team rules (an informational app answers 403
 * `read-only`). 409 `test-ended` when the copy is gone: start the test again.
 */
import { NextResponse } from '@/server/http-compat';
import {
  ReviewTestGoneError,
  ReviewTestReadOnlyError,
  reviewTestSql,
} from '@mantle/content/app-review-test';
import { getOwnerOr401 } from '@/lib/auth';
import { AppDbBody, appDbBodyError, appDbErrorResponse } from '@/lib/app-db-broker-body';
import { readJsonCapped } from '@/lib/body-limit';
import { readOnlyAppResponse } from '@/lib/client-apps';
import { rateLimit } from '@/lib/rate-limit';
import { reviewAppOr404, reviewTester } from '@/lib/review-apps';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const gate = rateLimit(`review-test-db:${user.actor.id}`, { max: 300, windowMs: 60_000 });
  if (!gate.ok) {
    return NextResponse.json(
      { ok: false, error: 'too many requests' },
      { status: 429, headers: { 'retry-after': String(gate.retryAfterSec) } },
    );
  }
  const parsed = AppDbBody.safeParse((await readJsonCapped(req)) ?? {});
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: appDbBodyError(parsed.error) }, { status: 400 });
  }
  const app = await reviewAppOr404((await ctx.params).id);
  if (app instanceof Response) return app;
  const { op, sql, params } = parsed.data;
  try {
    const output = await reviewTestSql(reviewTester(user), app, op, sql, params);
    return NextResponse.json({ ok: true, output });
  } catch (err) {
    if (err instanceof ReviewTestGoneError) {
      return NextResponse.json(
        { ok: false, error: err.message, reason: 'test-ended' },
        { status: 409 },
      );
    }
    if (err instanceof ReviewTestReadOnlyError) return readOnlyAppResponse(err.message);
    // Not logged on the app: the test touches nothing of it.
    return appDbErrorResponse(err, 'review-test/db-broker');
  }
}
