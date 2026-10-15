import { NextResponse } from '@/server/http-compat';
import { getChatThread } from '@mantle/db';
import { UUID_RE } from '@mantle/std';
import { chatLoginCaller } from '@/lib/auth';
import { messagesForReader, resolveChatAgentById } from '@/lib/assistant-chat';
import { recentAssistantMessages } from '@/lib/assistant';
import { chatThreadRow, threadRange } from '@/lib/chat-threads';

/**
 * GET /api/assistant/threads/<id>: one chat thread with its summary and its
 * latest 100 messages (chat archive, docs/conversation.md §6c). Older pages:
 * /api/assistant/messages?thread=<id>&before=<iso>. An archived thread is
 * read-only; there is no write route for it.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const login = chatLoginCaller();
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  // The login's own thread (W7c): another login's thread is not found, nor
  // one with an agent the login may no longer chat with.
  const found = await getChatThread(login.ownerId, id, login.loginId);
  const thread = found && (await resolveChatAgentById(login, found.agentId)) ? found : null;
  if (!thread) return NextResponse.json({ error: 'thread not found' }, { status: 404 });
  const [row, messages] = await Promise.all([
    chatThreadRow(login.ownerId, thread),
    recentAssistantMessages(login.ownerId, thread.agentId, login.loginId, 100, threadRange(thread)),
  ]);
  return NextResponse.json({ thread: row, messages: await messagesForReader(login, messages) });
}
