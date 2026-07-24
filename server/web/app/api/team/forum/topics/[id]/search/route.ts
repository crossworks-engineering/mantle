/**
 * GET /api/team/forum/topics/[id]/search?q= — posts in ONE topic whose body
 * matches the query, newest first. The in-thread search behind the topic
 * reader's find box. Visibility is enforced through getForumTopic (a member
 * asking about another member's private topic gets the same 404 as a bogus id),
 * so a leaked link can never search a thread it couldn't already read.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getForumTopic, searchForumPosts } from '@mantle/content';
import { resolveTeamChatCaller } from '@/lib/team-chat-gate';


const IdParams = z.object({ id: z.string().uuid() });

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const caller = await resolveTeamChatCaller(req);
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'invalid topic id' }, { status: 400 });
  const topicId = idParsed.data.id;

  const topic = await getForumTopic(caller.ownerId, topicId, {
    kind: 'member',
    contactId: caller.contactId,
  });
  if (!topic) return NextResponse.json({ error: 'topic not found' }, { status: 404 });

  const query = new URL(req.url).searchParams.get('q')?.trim() ?? '';
  if (!query) return NextResponse.json({ matches: [] });

  const matches = await searchForumPosts(caller.ownerId, topicId, { query });
  return NextResponse.json({ matches });
}
