import { NextResponse } from '@/server/http-compat';
import { chatLoginCaller } from '@/lib/auth';
import { resolveChatAgent } from '@/lib/assistant-chat';
import { chatThreadRows } from '@/lib/chat-threads';
import { archiveResponse } from '@/lib/chat-archive-http';
import { claimMemberChatWork } from '@/lib/workspace-turn';
import { readJson } from '@/lib/read-body';

/**
 * GET  /api/assistant/threads[?agent=<slug>]: the login's OWN threads with
 *      the agent, newest first (the open one on top).
 * POST /api/assistant/threads { agent? }: "New chat", archive the login's
 *      own open thread with the agent and open a new one.
 *
 * Any login (W7c): each user has their own threads with each assistant and
 * reads and archives only those.
 */
export async function GET(req: Request) {
  const login = chatLoginCaller();
  const slug = new URL(req.url).searchParams.get('agent') ?? undefined;
  const agent = await resolveChatAgent(login, slug);
  if (!agent) return NextResponse.json({ threads: [] });
  const threads = await chatThreadRows(login.ownerId, agent.id, login.loginId);
  return NextResponse.json({ agent: { id: agent.id, slug: agent.slug }, threads });
}

export async function POST(req: Request) {
  const login = chatLoginCaller();
  const body = (await readJson(req, { empty: null })) as { agent?: unknown } | null;
  const slug = typeof body?.agent === 'string' && body.agent ? body.agent : undefined;
  const agent = await resolveChatAgent(login, slug);
  if (!agent) return NextResponse.json({ error: 'no chat agent' }, { status: 404 });
  // Archiving summarises the chat (one model call): metered for a login
  // that is not an Admin user (W7c fix round 1, L2).
  const limited = await claimMemberChatWork(login, 'summary');
  if (limited) return limited;
  return archiveResponse({
    ownerId: login.ownerId,
    agentId: agent.id,
    loginId: login.loginId,
    archivedBy: login.loginId,
  });
}
