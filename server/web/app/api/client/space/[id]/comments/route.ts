import { NextResponse } from '@/server/http-compat';
import { addMineComment, listMineComments } from '@mantle/content';
import type { ClientCommentThread } from '@mantle/client-types';
import { getClientOr401 } from '@/lib/auth';
import { readJsonNoNul } from '@/lib/strip-nul';
import {
  assertClientItem,
  brandName,
  clientAuthor,
  clientCommentDto,
  clientWithAdminGuard,
  clientWriteGate,
  inMyClientSpace,
} from '@/lib/client-space';
import { CommentBody, notFound, SpaceIdParams, spaceStateResponse } from '@/lib/member-space';
import { commentPageQuery } from '@/lib/comment-page';
import { firstIssue } from '@/lib/zod-issue';

/**
 * GET /api/client/space/:id/comments[?before=ISO] : the review talk on one of
 * the CLIENT's own items: its newest 100 comments, oldest first, and
 * `hasMore` (client logins C5). Row security shows a
 * client only a reviewer's review comments and their own (0194), never a
 * member's comment; a reviewer's comment wears the brand name, never a
 * staff name. POST { body } : add to it, open while the item is submitted
 * (409 `not-shared` otherwise); written as the client's own review talk. At
 * most 100 comments a day across every thread (429 `comment-cap`), 1000 on
 * one thread (409 `thread-full`).
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const client = await getClientOr401();
  if (client instanceof Response) return client;
  const params = SpaceIdParams.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const page = commentPageQuery(req);
  if (page instanceof Response) return page;
  const held = await clientWithAdminGuard(client, params.data.id);
  if (held) return held;
  let thread;
  try {
    thread = await inMyClientSpace(client, async () => {
      await assertClientItem(client.spaceId, params.data.id);
      return listMineComments(client.spaceId, params.data.id, page);
    });
  } catch (err) {
    return spaceStateResponse(err);
  }
  if (!thread) return notFound();
  const brand = await brandName(client.anchorId);
  const body: ClientCommentThread = {
    comments: thread.rows.map((r) => clientCommentDto(r, client, brand)),
    hasMore: thread.hasMore,
  };
  return NextResponse.json(body);
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const client = await getClientOr401();
  if (client instanceof Response) return client;
  const limited = clientWriteGate(client);
  if (limited) return limited;
  const params = SpaceIdParams.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const held = await clientWithAdminGuard(client, params.data.id);
  if (held) return held;
  const body = CommentBody.safeParse(await readJsonNoNul(req));
  if (!body.success) return NextResponse.json({ error: firstIssue(body.error) }, { status: 400 });
  try {
    const row = await inMyClientSpace(client, async () => {
      await assertClientItem(client.spaceId, params.data.id);
      return addMineComment(
        client.spaceId,
        client.anchorId,
        params.data.id,
        clientAuthor(client),
        body.data.body,
      );
    });
    const brand = await brandName(client.anchorId);
    return NextResponse.json({ comment: clientCommentDto(row, client, brand) }, { status: 201 });
  } catch (err) {
    return spaceStateResponse(err);
  }
}
