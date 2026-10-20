import { NextResponse } from '@/server/http-compat';
import { getChatThread } from '@mantle/db';
import { UUID_RE } from '@mantle/std';
import { summarizeChatThread } from '@mantle/runtime/agent';
import { chatCaller } from '@/lib/auth';
import { resolveChatAgentById } from '@/lib/assistant-chat';
import { archiveResponse } from '@/lib/chat-archive-http';
import { claimMemberChatWork } from '@/lib/workspace-turn';
import { inRuleInQuery } from '@/lib/auth/rule-in-query';

/**
 * POST /api/assistant/threads/<id>/continue: "Continue from this" (chat
 * archive, docs/conversation.md §6c). Starts a new chat for the thread's
 * agent whose context opens with that archived thread's summary, not its raw
 * turns. The current chat is archived first, like "New chat" (and summarised
 * in this request); an empty current chat is only re-seeded. A previous chat
 * whose summary failed at archive time is summarised first (one call, on this
 * click only), or the new chat would start with nothing to continue from.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const login = chatCaller();
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  // The login's own thread (W7c): another login's thread is not found, nor
  // one with an agent the login may no longer chat with.
  const found = await getChatThread(login.ownerId, id, login.loginId);
  const thread = found && (await resolveChatAgentById(login, found.agentId)) ? found : null;
  if (!thread || thread.status !== 'archived') {
    return NextResponse.json({ error: 'archived chat not found' }, { status: 404 });
  }
  // Continuing archives the current chat (a summary) and may summarise this
  // one: metered for a login that is not an Admin user (W7c fix round 1, L2).
  const limited = await claimMemberChatWork(login, 'summary');
  if (limited) return limited;
  if (!thread.summaryNodeId) {
    await inRuleInQuery(() => summarizeChatThread(login.ownerId, thread.id, login.loginId)).catch(
      (err) => {
        console.warn('[api/assistant/threads] summary before continue failed:', err);
      },
    );
  }
  return archiveResponse({
    ownerId: login.ownerId,
    agentId: thread.agentId,
    loginId: login.loginId,
    archivedBy: login.loginId,
    continueFrom: thread.id,
  });
}
