/**
 * POST /api/apps/members/:id/test/tool-broker: host.tools.call() of an
 * admin's TEST run of a member's app. Always at TEAM rules (the author
 * ceiling, never the admin's own: memberAppToolVerdict, declared, built-in,
 * read only, no confirmation), on the team role, on a team surface naming
 * the admin's login. Stricter than a member's run: no outside tool at all
 * (no MCP or HTTP connector, even one opened to team apps), and no write,
 * so a test reaches nothing outside the brain and changes nothing in it
 * (403 `reason: 'review-test-read-only'`, which the app screen words as
 * "Test mode blocks tools that change data."). A declared tool the TEAM
 * rules refuse (no team-level group, it spends model work, it needs a
 * confirmation) is not test mode at work: it fails the same way in every
 * member's run, so it answers 403 `reason: 'team-rules'` with the rule's own
 * words (access matrix T22), and the screen says that instead. Nothing runs
 * without the admin's running test (409 `test-ended`). Each call is logged
 * on the app's activity (`via: 'review-test'`): it read brain data.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { withViewer } from '@mantle/db';
import { recordAppAccess } from '@mantle/content';
import { ReviewTestGoneError, requireReviewTest } from '@mantle/content/app-review-test';
import { appToolScope, appToolVerdict, dispatchTool } from '@mantle/tools';
import { getOwnerOr401 } from '@/lib/auth';
import { readJsonCapped } from '@/lib/body-limit';
import { rateLimit } from '@/lib/rate-limit';
import { reviewAppOr404, reviewTester } from '@/lib/review-apps';

const Body = z.object({
  slug: z.string().min(1).max(120),
  input: z.record(z.string(), z.unknown()).optional().default({}),
});

/** Why a test refuses a write or an outside (connector) tool. */
const TEST_READ_ONLY = 'Test mode blocks tools that change data.';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const gate = rateLimit(`review-test-tool:${user.actor.id}`, { max: 60, windowMs: 60_000 });
  if (!gate.ok) {
    return NextResponse.json(
      { ok: false, error: 'too many requests' },
      { status: 429, headers: { 'retry-after': String(gate.retryAfterSec) } },
    );
  }
  const parsed = Body.safeParse((await readJsonCapped(req)) ?? {});
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'invalid input' }, { status: 400 });
  }
  const app = await reviewAppOr404((await ctx.params).id);
  if (app instanceof Response) return app;
  try {
    await requireReviewTest(reviewTester(user), app.id);
  } catch (err) {
    if (!(err instanceof ReviewTestGoneError)) throw err;
    return NextResponse.json(
      { ok: false, error: err.message, reason: 'test-ended' },
      { status: 409 },
    );
  }
  const { slug, input } = parsed.data;
  const verdict = await appToolVerdict('team', user.id, app.declaredTools, slug);
  const refused = !verdict.ok
    ? verdict.reason
    : verdict.write || verdict.tool.handler.kind !== 'builtin'
      ? TEST_READ_ONLY
      : null;
  recordAppAccess({
    ownerId: app.spaceId,
    appNodeId: app.id,
    actorId: user.actor.id,
    kind: 'tool',
    detail: refused ? { via: 'review-test', slug, refused } : { via: 'review-test', slug },
  });
  if (!verdict.ok) {
    // A declared tool the team rules refuse (it writes, spends model work,
    // needs a confirmation, or sits in no team-level group) fails in every
    // member's run too, test or not (access matrix T22): its own reason, so
    // the screen says the team rules refused it, in their words, instead of
    // "not declared" or "test mode". An undeclared tool keeps the plain
    // answer.
    const declared = app.declaredTools.includes(slug);
    return NextResponse.json(
      {
        ok: false,
        error: verdict.reason,
        ...(declared && verdict.status === 403 ? { reason: 'team-rules' } : {}),
      },
      { status: verdict.status },
    );
  }
  if (refused) {
    return NextResponse.json(
      { ok: false, error: refused, reason: 'review-test-read-only' },
      { status: 403 },
    );
  }
  const scope = appToolScope('team', {
    loginId: user.actor.id,
    name: user.actor.displayName?.trim() || user.actor.email.split('@')[0] || 'admin',
  });
  const result = await withViewer(scope.viewer, () =>
    dispatchTool(verdict.tool, input, { ownerId: user.id, surface: scope.surface }),
  );
  return NextResponse.json(result);
}
