import { NextResponse } from '@/server/http-compat';
import { getChatThread } from '@mantle/db';
import { UUID_RE } from '@mantle/std';
import { summarizeChatThread } from '@mantle/runtime/agent';
import { chatCaller } from '@/lib/auth';
import { resolveChatAgentById } from '@/lib/assistant-chat';
import { chatThreadRow } from '@/lib/chat-threads';
import { claimMemberChatWork } from '@/lib/workspace-turn';
import { inRuleInQuery } from '@/lib/auth/rule-in-query';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'self',
    open: 'chat',
    item: { none: 'not decided yet: the write names an item no check reads' },
  },
});

/**
 * POST /api/assistant/threads/<id>/summarize: retry the summary of an archived
 * chat whose first attempt failed (a provider outage at archive time). Only a
 * person's click runs it, and a thread that already has a summary is returned
 * unchanged, so it never re-bills (chat archive, docs/conversation.md §6c).
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
  // A summary is a model call: metered for a login that is not an Admin
  // user (W7c fix round 1, L2). One that exists already costs nothing.
  if (!thread.summaryNodeId) {
    const limited = await claimMemberChatWork(login, 'summary');
    if (limited) return limited;
  }
  try {
    const updated = await inRuleInQuery(() =>
      summarizeChatThread(login.ownerId, id, login.loginId),
    );
    return NextResponse.json({ thread: await chatThreadRow(login.ownerId, updated ?? thread) });
  } catch (err) {
    console.warn('[api/assistant/threads] summarize failed:', err);
    return NextResponse.json(
      { error: 'The summary could not be written. Try again later.' },
      { status: 502 },
    );
  }
}
