/**
 * GET /api/team-admin/member-items/:id/bytes[?node=<fileId>][&thumb=1] : the
 * bytes of a shared member file (:id), or of a file the shared item :id
 * embeds (`node`, in its bundle and itself shared with the team). :id must
 * be an active member's item shared with the team; read at team level.
 * Owner session or the owner's `?at=` asset token (an <img> src cannot carry
 * a bearer).
 */
import { z } from 'zod';
import { openMemberFileShared } from '@mantle/content';
import { getOwnerForAsset } from '@/lib/auth';
import { spaceFileResponse } from '@/lib/member-space';
import { SubmissionParams, reviewNotFound } from '@/lib/member-review';

const Node = z.string().uuid();

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerForAsset(req);
  if (user instanceof Response) return user;
  const params = SubmissionParams.safeParse(await ctx.params);
  if (!params.success) return reviewNotFound();
  const node = Node.safeParse(new URL(req.url).searchParams.get('node') ?? params.data.id);
  if (!node.success) return reviewNotFound();
  return spaceFileResponse(req, await openMemberFileShared(params.data.id, node.data));
}
