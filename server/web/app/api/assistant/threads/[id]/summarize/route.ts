import { NextResponse } from '@/server/http-compat';
import { getChatThread } from '@mantle/db';
import { UUID_RE } from '@mantle/std';
import { summarizeChatThread } from '@mantle/runtime/agent';
import { getOwnerOr401 } from '@/lib/auth';
import { chatThreadRow } from '@/lib/chat-threads';

/**
 * POST /api/assistant/threads/<id>/summarize: retry the summary of an archived
 * chat whose first attempt failed (a provider outage at archive time). Only a
 * person's click runs it, and a thread that already has a summary is returned
 * unchanged, so it never re-bills (chat archive, docs/conversation.md §6c).
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
  try {
    const updated = await summarizeChatThread(user.id, id);
    return NextResponse.json({ thread: await chatThreadRow(user.id, updated ?? thread) });
  } catch (err) {
    console.warn('[api/assistant/threads] summarize failed:', err);
    return NextResponse.json(
      { error: 'The summary could not be written. Try again later.' },
      { status: 502 },
    );
  }
}
