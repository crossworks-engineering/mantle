/**
 * POST /api/apps/members/:id/accept
 *   { level: 'admin' | 'team', trustTools?: boolean, version, reviewHash }
 * Approve a submitted member app into the brain. `version` and `reviewHash`
 * are what GET /api/apps/members/:id showed the admin: the accept refuses
 * (409 `changed`) when the app moved since (M3 audit). It moves into the
 * brain's Apps at `level`, ids unchanged, its data and history with it.
 * Without `trustTools` the author ceiling stays: the app runs its tools at
 * team rules for every runner, admins too.
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
  version: z.number().int().min(1),
  reviewHash: z.string().regex(/^[0-9a-f]{64}$/),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const id = spaceAppId((await ctx.params).id);
  if (!id) return spaceAppNotFound();
  const body = Body.safeParse(await req.json().catch(() => ({})));
  if (!body.success) {
    return NextResponse.json(
      {
        ok: false,
        error: "level must be 'admin' or 'team', with the version and reviewHash of the review",
      },
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
