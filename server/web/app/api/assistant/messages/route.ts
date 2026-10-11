import { NextResponse, type NextRequest } from '@/server/http-compat';
import { getChatLoginOr401 } from '@/lib/auth';
import { getChatThread, openChatThread } from '@mantle/db';
import { UUID_RE } from '@mantle/std';
import { assistantMessagesBefore } from '@/lib/assistant';
import { messagesForReader, resolveChatAgent, resolveChatAgentById } from '@/lib/assistant-chat';
import { threadRange } from '@/lib/chat-threads';

/**
 * Older page of assistant messages for scroll-up lazy loading. Returns up
 * to `limit` (default 100) messages before the `before` ISO cursor, scoped
 * to the login's OWN thread with the selected agent (any login since W7c;
 * each user reads only their own threads). getChatLoginOr401 401s an
 * unauthenticated/expired client rather than redirecting to /login.
 *
 * Chat archive (docs/conversation.md §6c): without `?thread=` the page stays
 * inside the agent's OPEN thread, so an archived chat never pages back into
 * the live window. `?thread=<id>` pages inside that thread's range instead
 * (the read-only archived view); the thread names its agent.
 */

const PAGE = 100;

export async function GET(req: NextRequest) {
  const login = await getChatLoginOr401();
  if (login instanceof Response) return login;
  const { searchParams } = new URL(req.url);

  // `before` is the load-older pagination cursor. Absent means "the latest page"
  // (syncLatest on mount / after a foreign turn), so default to now; only a
  // PRESENT-but-unparseable value is a 400.
  const beforeParam = searchParams.get('before');
  if (beforeParam && Number.isNaN(Date.parse(beforeParam))) {
    return NextResponse.json({ error: 'invalid `before` timestamp' }, { status: 400 });
  }
  const before = beforeParam ?? new Date().toISOString();
  const limitParam = Number.parseInt(searchParams.get('limit') ?? '', 10);
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 200) : PAGE;
  const slug = searchParams.get('agent') ?? undefined;
  const threadId = searchParams.get('thread');
  if (threadId && !UUID_RE.test(threadId)) {
    return NextResponse.json({ error: 'invalid `thread` id' }, { status: 400 });
  }

  if (threadId) {
    // The login's own thread only: another login's thread is not found.
    const thread = await getChatThread(login.ownerId, threadId, login.loginId);
    if (!thread) return NextResponse.json({ error: 'thread not found' }, { status: 404 });
    // And only with an agent the login may still chat with.
    const agent = await resolveChatAgentById(login, thread.agentId);
    if (!agent) return NextResponse.json({ error: 'thread not found' }, { status: 404 });
    const messages = await assistantMessagesBefore(
      login.ownerId,
      thread.agentId,
      login.loginId,
      before,
      limit,
      threadRange(thread),
    );
    return NextResponse.json(
      { messages: await messagesForReader(login, messages) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // No `?agent=` → this login's assigned assistant, else the brain default.
  const agent = await resolveChatAgent(login, slug);
  if (!agent) return NextResponse.json({ messages: [] });

  // Per-agent thread — no cross-agent or legacy fold-in. See migration
  // 0049 + the assistant_messages schema header.
  // Bounded to the open thread (chat archive).
  const open = await openChatThread(login.ownerId, agent.id, login.loginId);
  const messages = await assistantMessagesBefore(
    login.ownerId,
    agent.id,
    login.loginId,
    before,
    limit,
    threadRange(open),
  );
  return NextResponse.json(
    { messages: await messagesForReader(login, messages) },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
