/**
 * POST /api/apps/members/:id/test/tool-broker: host.tools.call() of an
 * admin's TEST run of a member's app. Always at TEAM rules (the author
 * ceiling, never the admin's own: memberAppToolVerdict, declared, built-in,
 * read only, no confirmation), on the team role, on a team surface naming
 * the admin's login. Stricter than a member's run: no outside tool at all
 * (no MCP or HTTP connector, even one opened to team apps), and no write,
 * so a test reaches nothing outside the brain and changes nothing in it.
 * Each call is logged on the app's activity (`via: 'review-test'`): it read
 * brain data.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { withViewer } from '@mantle/db';
import { recordAppAccess } from '@mantle/content';
import { appToolScope, appToolVerdict, dispatchTool } from '@mantle/tools';
import { getOwnerOr401 } from '@/lib/auth';
import { readJsonCapped } from '@/lib/body-limit';
import { rateLimit } from '@/lib/rate-limit';
import { reviewAppOr404 } from '@/lib/review-apps';

const Body = z.object({
  slug: z.string().min(1).max(120),
  input: z.record(z.string(), z.unknown()).optional().default({}),
});

const NO_OUTSIDE =
  'A test run uses only built-in brain tools that read. Outside tools (connectors) run once the app is approved.';

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
  const { slug, input } = parsed.data;
  const verdict = await appToolVerdict('team', user.id, app.declaredTools, slug);
  const refused = !verdict.ok
    ? verdict.reason
    : verdict.write || verdict.tool.handler.kind !== 'builtin'
      ? NO_OUTSIDE
      : null;
  recordAppAccess({
    ownerId: app.spaceId,
    appNodeId: app.id,
    actorId: user.actor.id,
    kind: 'tool',
    detail: refused ? { via: 'review-test', slug, refused } : { via: 'review-test', slug },
  });
  if (!verdict.ok) {
    return NextResponse.json({ ok: false, error: verdict.reason }, { status: verdict.status });
  }
  if (refused) return NextResponse.json({ ok: false, error: refused }, { status: 403 });
  const scope = appToolScope('team', {
    loginId: user.actor.id,
    name: user.actor.displayName?.trim() || user.actor.email.split('@')[0] || 'admin',
  });
  const result = await withViewer(scope.viewer, () =>
    dispatchTool(verdict.tool, input, { ownerId: user.id, surface: scope.surface }),
  );
  return NextResponse.json(result);
}
