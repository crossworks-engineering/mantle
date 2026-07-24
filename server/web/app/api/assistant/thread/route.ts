import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import {
  listAssistantAgents,
  recentAssistantMessages,
  resolveAssistantAgent,
} from '@/lib/assistant';

/**
 * GET /api/assistant/thread?agent=<slug> — the initial /assistant bundle: the
 * chattable agent list (header picker), the resolved active agent (?agent slug
 * hint → priority default), and that agent's most-recent thread (100 msgs).
 * Owner-scoped. Scroll-up paging stays on /api/assistant/messages.
 */

export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const slug = new URL(req.url).searchParams.get('agent') ?? undefined;

  const [agents, agent] = await Promise.all([
    listAssistantAgents(user.id),
    resolveAssistantAgent(user.id, slug),
  ]);
  const messages = agent ? await recentAssistantMessages(user.id, agent.id, 100) : [];

  return NextResponse.json(
    { agents, agent, messages },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
