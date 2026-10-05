import { NextResponse } from '@/server/http-compat';
import { getChatThread } from '@mantle/db';
import { UUID_RE } from '@mantle/std';
import { getOwnerOr401 } from '@/lib/auth';
import { archiveResponse } from '@/lib/chat-archive-http';

/**
 * POST /api/assistant/threads/<id>/continue: "Continue from this" (chat
 * archive, docs/conversation.md §6c). Starts a new chat for the thread's
 * agent whose context opens with that archived thread's summary, not its raw
 * turns. The current chat is archived first, like "New chat" (and summarised
 * in this request); an empty current chat is only re-seeded.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const thread = await getChatThread(user.id, id);
  if (!thread || thread.status !== 'archived') {
    return NextResponse.json({ error: 'archived chat not found' }, { status: 404 });
  }
  return archiveResponse({
    ownerId: user.id,
    agentId: thread.agentId,
    archivedBy: user.actor.id,
    continueFrom: thread.id,
  });
}
