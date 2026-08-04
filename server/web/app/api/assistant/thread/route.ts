import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import {
  listAssistantAgents,
  recentAssistantMessages,
  resolveAgentForActor,
} from '@/lib/assistant';
import { getAssignedAgentSummary } from '@/lib/agents';

/**
 * GET /api/assistant/thread?agent=<slug> — the initial /assistant bundle: the
 * chattable agent list (header picker), the resolved active agent (?agent slug
 * hint → this login's assigned assistant → priority default), and that agent's
 * most-recent thread (100 msgs). Owner-scoped. Scroll-up paging stays on
 * /api/assistant/messages.
 *
 * `assigned` is the handshake that makes an assignment actually take effect in a
 * browser that already holds a `mantle_assistant_agent` cookie for the old
 * shared agent — i.e. exactly the co-admins this feature is for. The client
 * compares `assignedAt` against a local watermark and overrides the cookie once.
 */

export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const slug = new URL(req.url).searchParams.get('agent') ?? undefined;

  const [agents, agent, assigned] = await Promise.all([
    listAssistantAgents(user.id),
    resolveAgentForActor(user, slug),
    getAssignedAgentSummary(user.id, user.actor.id),
  ]);
  const messages = agent ? await recentAssistantMessages(user.id, agent.id, 100) : [];

  return NextResponse.json(
    {
      agents,
      agent,
      messages,
      assigned: assigned ? { slug: assigned.slug, assignedAt: assigned.assignedAt } : null,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
