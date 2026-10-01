/**
 * PATCH /api/access/tool-groups/:slug  { audience } -> set a tool group's level.
 *
 * Owner only. Member logins Phase 0b: an agent may hold only groups at or
 * below its level, so raising a group above an agent that holds it is refused.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { firstIssue } from '@/lib/zod-issue';
import { AccessError, setToolGroupAudience } from '@mantle/content';
import { VIEWER_LEVELS } from '@mantle/db';

const Params = z.object({ slug: z.string().min(1).max(120) });
const PatchBody = z.object({ audience: z.enum(VIEWER_LEVELS) });

export async function PATCH(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const params = Params.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid slug.' }, { status: 400 });
  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: firstIssue(parsed.error, 'Invalid input.') },
      { status: 400 },
    );
  }
  try {
    return NextResponse.json({
      tool_group: await setToolGroupAudience(user.id, params.data.slug, parsed.data.audience),
    });
  } catch (err) {
    if (err instanceof AccessError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.code === 'not_found' ? 404 : 400 },
      );
    }
    throw err;
  }
}
