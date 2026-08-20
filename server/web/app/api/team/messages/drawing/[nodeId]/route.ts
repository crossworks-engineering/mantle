/**
 * GET /api/team/messages/drawing/[nodeId] — a member loading a DRAWING attached
 * to a message in their own Team Chat thread.
 *
 * The drawing twin of `messages/media/[nodeId]`, and it exists so the `draw:`
 * marker means the same thing on both member surfaces. A marker that rendered
 * in the Forum and broke in Team Chat would be a worse answer than not having
 * one — the reply text does not know which surface it will be read on.
 *
 * Authz is simpler than the forum's, for the reason it always was: a thread has
 * exactly one member, so the contact id on the row IS the rule.
 */
import { teamThreadHasAttachedNode } from '@mantle/content';
import { gateTeamMedia, mediaNotFound, serveTeamDrawing } from '@/lib/team-media';

export async function GET(req: Request, ctx: { params: Promise<{ nodeId: string }> }) {
  const { nodeId } = await ctx.params;
  const gated = await gateTeamMedia(req, nodeId, 'team-drawing');
  if (gated instanceof Response) return gated;
  const { ownerId, contactId } = gated;

  if (!(await teamThreadHasAttachedNode(ownerId, contactId, nodeId))) return mediaNotFound();

  return serveTeamDrawing(ownerId, nodeId);
}
