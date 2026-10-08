/**
 * POST /api/team-admin/app-submissions/:id/accept
 *   { level: 'admin' | 'team', trustTools?: boolean }
 * Accept a submitted member app into the brain (team apps Phase 3): it moves
 * into the brain's Apps at `level`, ids unchanged, its data and history with
 * it. Client and public are set later, as for any app. Without `trustTools`
 * the author ceiling stays: the app runs its tools at team rules for every
 * runner, admins too. With it, the admin has reviewed the declared tools and
 * the app runs at the runner's own rules.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { acceptSpaceApp } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';
import { reviewer } from '@/lib/member-review';
import { spaceAppErrorResponse, spaceAppId, spaceAppNotFound } from '@/lib/space-apps';

const Body = z.object({
  level: z.enum(['admin', 'team']),
  trustTools: z.boolean().optional().default(false),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const id = spaceAppId((await ctx.params).id);
  if (!id) return spaceAppNotFound();
  const body = Body.safeParse(await req.json().catch(() => ({})));
  if (!body.success) {
    return NextResponse.json(
      { ok: false, error: "level must be 'admin' or 'team'" },
      { status: 400 },
    );
  }
  try {
    const res = await acceptSpaceApp(user.id, id, reviewer(user), body.data);
    return NextResponse.json({ ok: true, ...res });
  } catch (err) {
    return spaceAppErrorResponse(err);
  }
}
