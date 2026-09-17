/**
 * GET /api/team/forum/media/[nodeId] — a member loading a picture the agent
 * attached to a forum post.
 *
 * Authz: the node must be on a COMPLETE post in a topic this member can see.
 * Candidate topics come from the posts themselves (forumTopicsWithAttachedNode)
 * and each is checked with the member's own view, so a node posted into two
 * topics is reachable through whichever one they are actually in. Absent ==
 * forbidden == uniform 404 — see lib/team-media.ts.
 */
import { getForumTopic, forumTopicsWithAttachedNode } from '@mantle/content';
import { gateTeamMedia, mediaNotFound, serveTeamMedia } from '@/lib/team-media';

export async function GET(req: Request, ctx: { params: Promise<{ nodeId: string }> }) {
  const { nodeId } = await ctx.params;
  const gated = await gateTeamMedia(req, nodeId, 'forum-media');
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

  return serveTeamMedia(ownerId, nodeId);
}
