import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { withViewer } from '@mantle/db';
import { recordAppAccess } from '@mantle/content';
import { appToolLevel, appToolScope, appToolVerdict, dispatchTool } from '@mantle/tools';
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
 * at dispatch time, every call, by the rules of the LOWER of the member's
 * level and the app's (appToolLevel, client tier audit L1): a team app gets
 * the member rules (memberAppToolVerdict: declared by the app, a built-in,
 * no confirmation, in an enabled team-level tool group, not on the refused
 * list, read-only) and runs on the TEAM role, on a team surface that names
 * the login (so team refusals apply), with the private corpus off. A
 * client-level app gets the client rules (clientAppToolVerdict) and runs on
 * the CLIENT role, on a client surface, as a client's run does: its
 * database is read by every client, so nothing above client level may land
 * in it. A public app runs no tools. Refused calls are logged too.
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
  const app = await memberAppOr404(member.anchorId, id);
  if (app instanceof Response) return app;

  const { slug, input } = parsed.data;
  const level = appToolLevel('team', app.audience);
  const verdict = await appToolVerdict(
    level,
    member.anchorId,
    app.manifest.toolSlugs ?? [],
    slug,
  );
  recordAppAccess({
    ownerId: member.anchorId,
    appNodeId: app.id,
    actorId: member.loginId,
    kind: 'tool',
    detail: verdict.ok ? { via: 'member', slug } : { via: 'member', slug, refused: verdict.reason },
  });
  if (!verdict.ok) {
    return NextResponse.json({ ok: false, error: verdict.reason }, { status: verdict.status });
  }
  const scope = appToolScope(level, { loginId: member.loginId, name: memberName(member) });
  const result = await withViewer(scope.viewer, () =>
    dispatchTool(verdict.tool, input, { ownerId: member.anchorId, surface: scope.surface }),
  );
  return NextResponse.json(result);
}
