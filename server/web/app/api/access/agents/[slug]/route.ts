/**
 * PATCH /api/access/agents/:slug  { audience } -> set an agent's level.
 *
 * Owner only. Member logins Phase 0b: an agent's level decides what it reads
 * (its turns run on that level's limited role) and who may chat with it.
 * Refused while the agent holds a tool group above the new level.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { getOwnerOr401 } from '@/lib/auth';
import { firstIssue } from '@/lib/zod-issue';
import { AccessError, setAgentAudience } from '@mantle/content';
import { agents, db, VIEWER_LEVELS } from '@mantle/db';

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
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.ownerId, user.id), eq(agents.slug, params.data.slug)))
    .limit(1);
  if (!agent) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  try {
    return NextResponse.json({
      agent: await setAgentAudience(user.id, agent.id, parsed.data.audience),
    });
  } catch (err) {
    if (err instanceof AccessError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
    }
    throw err;
  }
}
