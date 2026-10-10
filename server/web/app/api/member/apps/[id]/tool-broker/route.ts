import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { withViewer } from '@mantle/db';
import { recordAppAccess, recordAppError } from '@mantle/content';
import {
  appToolLevel,
  appToolScope,
  appToolVerdict,
  dispatchTool,
  outsideCallLogDetail,
} from '@mantle/tools';
import { getMemberOr401 } from '@/lib/auth';
import { memberAppOr404, memberName } from '@/lib/member-apps';
import { readJsonCapped } from '@/lib/body-limit';
import { rateLimit } from '@/lib/rate-limit';

const Body = z.object({
  slug: z.string().min(1).max(120),
  input: z.record(z.string(), z.unknown()).optional().default({}),
});

/**
 * POST /api/member/apps/:id/tool-broker: a member's run of an app calls
 * host.tools.call() (member logins Phase 4b, plan 4a). Run-only and checked
 * at dispatch time, every call, by the rules its holders allow (appToolLevel,
 * plan R2): an app a workspace of the member holds gets the member rules (memberAppToolVerdict: declared by the app, a built-in,
 * no confirmation, in an enabled team-level tool group, not on the refused
 * list, read-only) and runs on the TEAM role, on a team surface that names
 * the login (so team refusals apply), with the private corpus off. An
 * outside tool (mcp or http) passes only when an admin switched on "Team
 * apps may use" on it (external-access.ts), on the same role and surface.
 * Refused calls are logged too.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const gate = rateLimit(`member-tool-broker:${member.loginId}`, { max: 60, windowMs: 60_000 });
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
  const { id } = await ctx.params;
  const app = await memberAppOr404(member.anchorId, id, member.loginId);
  if (app instanceof Response) return app;

  const { slug, input } = parsed.data;
  // An app a member runs is held by a workspace of theirs, so it runs the
  // team rules (R2); a member-built app (team apps Phase 3) too, by the
  // author ceiling. The tools are the brain's, so the verdict and the
  // dispatch keep the brain as owner.
  const level = appToolLevel('team', 'team', app.spaceApp ? 'team' : 'admin');
  // The member's login: a connector tool also needs the login's workspace
  // rule, as on the member's own MCP (W4b fix round 2).
  const verdict = await appToolVerdict(
    level,
    member.anchorId,
    app.manifest.toolSlugs ?? [],
    slug,
    member.loginId,
    // A brain app: every workspace that holds it must hold the connector
    // (plan R2). A member's own space app has no holders.
    app.spaceApp ? undefined : { appId: app.id },
  );
  recordAppAccess({
    ownerId: app.ownerId,
    appNodeId: app.id,
    actorId: member.loginId,
    kind: 'tool',
    // An outside tool names its kind, so the log shows which member calls
    // reached outside the brain; a write (a connector tool without the
    // read-only mark, team apps Phase 2) keeps its input too.
    detail: verdict.ok
      ? { via: 'member', slug, ...outsideCallLogDetail(verdict, input) }
      : { via: 'member', slug, refused: verdict.reason },
  });
  const logError = (message: string, status: number) =>
    recordAppError({
      ownerId: app.ownerId,
      appNodeId: app.id,
      actorId: member.loginId,
      source: 'tool',
      via: 'member',
      slug,
      message,
      status,
    });
  if (!verdict.ok) {
    logError(verdict.reason, verdict.status);
    return NextResponse.json({ ok: false, error: verdict.reason }, { status: verdict.status });
  }
  // The run reads through the app (its holders met with the member's
  // workspaces), never the member's other workspaces (plan R2, H1). A space
  // app has no brain holders: team rules, the Team workspace.
  const scope = appToolScope(
    level,
    { loginId: member.loginId, name: memberName(member) },
    app.spaceApp ? { team: true } : { id: app.id },
  );
  const result = await withViewer(scope.viewer, scope.actsFor, () =>
    dispatchTool(verdict.tool, input, { ownerId: member.anchorId, surface: scope.surface }),
  );
  if (!result.ok) logError(result.error, 200);
  return NextResponse.json(result);
}
