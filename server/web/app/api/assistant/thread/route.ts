import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import {
  listAssistantAgents,
  recentAssistantMessages,
  resolveAgentForActor,
} from '@/lib/assistant';
import { openChatThread } from '@mantle/db';
import { getAssignedAgentSummary } from '@/lib/agents';
import { chatThreadRow, threadRange } from '@/lib/chat-threads';
import { getAgentExperience } from '@/lib/agent-experience';

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
 *
 * `?withMessages=0` returns the same bundle with `messages: []`. The mobile
 * companion needs the picker list and the resolved agent at launch — it has no
 * agent cookie, so `agent` IS its resolution — but it pages its own thread
 * through the Drift cache on /api/assistant/messages, so the 100 rows would be
 * fetched and thrown away on every cold start.
 *
 * Chat archive (docs/conversation.md §6c): `messages` are the OPEN thread's
 * only, and `thread` is that open thread (null for a chat never archived),
 * so the window can show "Continued from ..." and the thread list.
 */

export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const params = new URL(req.url).searchParams;
  const slug = params.get('agent') ?? undefined;
  // Opt-OUT, so an absent/garbled param keeps the full bundle every existing
  // caller expects. Only the explicit falsy spellings skip the thread.
  const withMessages = !['0', 'false', 'no'].includes(
    (params.get('withMessages') ?? '').trim().toLowerCase(),
  );

  const [agents, agent, assigned] = await Promise.all([
    listAssistantAgents(user.id),
    resolveAgentForActor(user, slug),
    getAssignedAgentSummary(user.id, user.actor.id),
  ]);
  const open = agent ? await openChatThread(user.id, agent.id) : null;
  const [messages, experience, thread] = await Promise.all([
    agent && withMessages ? recentAssistantMessages(user.id, agent.id, 100, threadRange(open)) : [],
    // The header shows the active agent's level badge; one scoped rollup.
    agent ? getAgentExperience(user.id, agent.id) : null,
    open ? chatThreadRow(user.id, open) : null,
  ]);

  return NextResponse.json(
    {
      agents,
      agent: agent ? { ...agent, experience } : null,
      messages,
      thread,
      assigned: assigned ? { slug: assigned.slug, assignedAt: assigned.assignedAt } : null,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
