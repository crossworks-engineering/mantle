/**
 * GET /api/team/forum/drawing/[nodeId] — a member loading a DRAWING attached to
 * a forum post.
 *
 * The sibling of `media/[nodeId]`, and deliberately a sibling rather than a
 * widening of it: that route serves file bytes and refuses anything whose mime
 * is not an image, which a draw node is not.
 *
 * Authz is `media/[nodeId]`'s, unchanged and for the same reason. The question
 * is asked of the POSTS — "is this node attached to something this member can
 * already read?" — never of the drawings tree, because that second question
 * answers "any drawing the responder ever touched", which is a different and
 * much larger door. Candidate topics come from the posts themselves and each is
 * checked against the member's own view, so a drawing posted into two topics is
 * reachable through whichever one they are actually in. Absent, forbidden and
 * malformed all answer 404, so node ids cannot be probed.
 */
import { getForumTopic, forumTopicsWithAttachedNode } from '@mantle/content';
import { gateTeamMedia, mediaNotFound, serveTeamDrawing } from '@/lib/team-media';

export async function GET(req: Request, ctx: { params: Promise<{ nodeId: string }> }) {
  const { nodeId } = await ctx.params;
  const gated = await gateTeamMedia(req, nodeId, 'forum-drawing');
  if (gated instanceof Response) return gated;
  const { ownerId, contactId } = gated;

  const topicIds = await forumTopicsWithAttachedNode(ownerId, nodeId);
  if (topicIds.length === 0) return mediaNotFound();

  let visible = false;
  for (const topicId of topicIds) {
    if (await getForumTopic(ownerId, topicId, { kind: 'member', contactId })) {
      visible = true;
      break;
    }
  }
  if (!visible) return mediaNotFound();

  return serveTeamDrawing(ownerId, nodeId);
}
