/**
 * GET /api/team/forum/topics/[id] — one topic + a transcript window
 * (ascending; `?before=<iso>` pages older, `?limit=` caps the window).
 * Visibility is enforced in getForumTopic: a member asking for another
 * member's private topic gets the same 404 as a bogus id.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getForumTopic, listForumPosts, listForumUploadStatesForTopic } from '@mantle/content';
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

  const url = new URL(req.url);
  const before = url.searchParams.get('before') ?? undefined;
  const limitRaw = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50;
  const [posts, uploadStates] = await Promise.all([
    listForumPosts(caller.ownerId, topicId, { before, limit }),
    // Blob review states for the attachment chips ("in review" badge) —
    // clients join posts[].attachments[].fileId → uploadStates[].id.
    listForumUploadStatesForTopic(caller.ownerId, topicId),
  ]);

  return NextResponse.json({
    topic: {
      id: topic.id,
      title: topic.title,
      kind: topic.kind,
      visibility: topic.visibility,
      pinned: topic.pinned,
      status: topic.status,
      authorName: topic.authorName,
      postCount: topic.postCount,
      createdAt: topic.createdAt.toISOString(),
      lastPostAt: topic.lastPostAt.toISOString(),
      mine: topic.createdByContactId === caller.contactId,
    },
    posts: posts.map((p) => ({
      id: p.id,
      authorKind: p.authorKind,
      authorName: p.authorName,
      mine: p.contactId === caller.contactId,
      body: p.body,
      status: p.status,
      // Deliberately NOT p.error: a failed agent turn's raw message carries
      // brain internals (provider errors, "api_key_id … not found") and this is
      // an external, all-members-visible surface. Members see a generic note;
      // the raw error stays owner-side (/team-admin + traces).
      attachments: p.attachments,
      createdAt: p.createdAt.toISOString(),
    })),
    uploadStates: uploadStates.map((u) => ({ id: u.id, status: u.status, sizeBytes: u.sizeBytes })),
  });
}
