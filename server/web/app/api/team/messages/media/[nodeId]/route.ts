/**
 * GET /api/team/messages/media/[nodeId] — a member loading a picture the agent
 * attached to a message in their own Team Chat thread.
 *
 * Authz is simpler than the forum's: a thread has exactly one member, so the
 * contact id on the row IS the rule. Absent == forbidden == uniform 404 — see
 * lib/team-media.ts.
 */
import { teamThreadHasAttachedNode } from '@mantle/content';
import { gateTeamMedia, mediaNotFound, serveTeamMedia } from '@/lib/team-media';

export async function GET(req: Request, ctx: { params: Promise<{ nodeId: string }> }) {
  const { nodeId } = await ctx.params;
  const gated = await gateTeamMedia(req, nodeId, 'team-media');
  if (gated instanceof Response) return gated;
  const { ownerId, contactId } = gated;

  if (!(await teamThreadHasAttachedNode(ownerId, contactId, nodeId))) return mediaNotFound();

  return serveTeamMedia(ownerId, nodeId);
}
