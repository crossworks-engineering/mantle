import { NextResponse } from '@/server/http-compat';
import { getChatThread } from '@mantle/db';
import { UUID_RE } from '@mantle/std';
import { getOwnerOr401 } from '@/lib/auth';
import { recentAssistantMessages } from '@/lib/assistant';
import { chatThreadRow, threadRange } from '@/lib/chat-threads';

/**
 * GET /api/assistant/threads/<id>: one chat thread with its summary and its
 * latest 100 messages (chat archive, docs/conversation.md §6c). Older pages:
 * /api/assistant/messages?thread=<id>&before=<iso>. An archived thread is
 * read-only; there is no write route for it.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const thread = await getChatThread(user.id, id);
  if (!thread) return NextResponse.json({ error: 'thread not found' }, { status: 404 });
  const [row, messages] = await Promise.all([
    chatThreadRow(user.id, thread),
    recentAssistantMessages(user.id, thread.agentId, 100, threadRange(thread)),
  ]);
  return NextResponse.json({ thread: row, messages }, { headers: { 'Cache-Control': 'no-store' } });
}
