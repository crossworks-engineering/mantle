/**
 * POST /api/team/forum/topics/[id]/read — mark a topic read for the calling
 * member (their unread dot). Best-effort by design; visibility is enforced so
 * the cursor write can't be used to probe private topic ids.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getForumTopic, markForumTopicRead } from '@mantle/content';
import { resolveTeamChatCaller } from '@/lib/team-chat-gate';


const IdParams = z.object({ id: z.string().uuid() });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const caller = await resolveTeamChatCaller(req);
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'invalid topic id' }, { status: 400 });

  const viewer = { kind: 'member' as const, contactId: caller.contactId };
  const topic = await getForumTopic(caller.ownerId, idParsed.data.id, viewer);
  if (!topic) return NextResponse.json({ error: 'topic not found' }, { status: 404 });

  await markForumTopicRead(caller.ownerId, viewer, topic.id);
  return NextResponse.json({ ok: true });
}
