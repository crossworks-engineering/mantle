import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { resolveAgentForActor } from '@/lib/assistant';
import { chatThreadRows } from '@/lib/chat-threads';
import { archiveResponse } from '@/lib/chat-archive-http';

/**
 * Chat threads of one agent (chat archive, docs/conversation.md §6c).
 *
 * GET  /api/assistant/threads?agent=<slug>  the thread list, newest first, the
 *      open thread on top ("Previous chats" in the UI are the archived ones).
 * POST /api/assistant/threads {agent?}      "New chat": archive the open chat
 *      and start a fresh one. Writes the one summary note of the archived
 *      thread inside this request (a single model call). An empty chat is a
 *      no-op (`archived: null`). 409 while a reply is still running.
 *
 * Owner-scoped like every /api/assistant route; the agent resolves as in
 * /api/assistant/thread (explicit slug, this login's agent, the default).
 */
export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const slug = new URL(req.url).searchParams.get('agent') ?? undefined;
  const agent = await resolveAgentForActor(user, slug);
  if (!agent) return NextResponse.json({ threads: [] });
  const threads = await chatThreadRows(user.id, agent.id);
  return NextResponse.json(
    { agent: { id: agent.id, slug: agent.slug }, threads },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const body = (await req.json().catch(() => null)) as { agent?: unknown } | null;
  const slug = typeof body?.agent === 'string' && body.agent ? body.agent : undefined;
  const agent = await resolveAgentForActor(user, slug);
  if (!agent) return NextResponse.json({ error: 'no chat agent' }, { status: 404 });
  return archiveResponse({ ownerId: user.id, agentId: agent.id, archivedBy: user.actor.id });
}
