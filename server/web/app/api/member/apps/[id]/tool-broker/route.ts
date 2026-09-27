import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { withViewer } from '@mantle/db';
import { recordAppAccess } from '@mantle/content';
import { dispatchTool, memberAppToolVerdict } from '@mantle/tools';
import { getMemberOr401 } from '@/lib/auth';
import { memberAppOr404, memberName } from '@/lib/member-apps';
import { rateLimit } from '@/lib/rate-limit';

const Body = z.object({
  slug: z.string().min(1).max(120),
  input: z.record(z.string(), z.unknown()).optional().default({}),
});

/**
 * POST /api/member/apps/:id/tool-broker: a member's run of an app calls
 * host.tools.call() (member logins Phase 4b, plan 4a). Run-only and checked
 * at dispatch time, every call (memberAppToolVerdict): declared by the app,
 * a built-in, no confirmation, in an enabled team-level tool group, not on
 * the refused list. Then it runs on the TEAM role, on a team surface that
 * names the login (so team refusals apply, unlike the web surface the share
 * brokers used), with the private corpus off.
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
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'invalid input' }, { status: 400 });
  }
  const { id } = await ctx.params;
  const app = await memberAppOr404(member.anchorId, id);
  if (app instanceof Response) return app;

  const { slug, input } = parsed.data;
  const verdict = await memberAppToolVerdict(member.anchorId, app.manifest.toolSlugs ?? [], slug);
  if (!verdict.ok) {
    return NextResponse.json({ ok: false, error: verdict.reason }, { status: verdict.status });
  }

  recordAppAccess({
    ownerId: member.anchorId,
    appNodeId: app.id,
    actorId: member.loginId,
    kind: 'tool',
    detail: { slug },
  });
  const result = await withViewer('team', () =>
    dispatchTool(verdict.tool, input, {
      ownerId: member.anchorId,
      surface: {
        kind: 'team',
        loginId: member.loginId,
        contactName: memberName(member),
        privateReads: false,
      },
    }),
  );
  return NextResponse.json(result);
}
