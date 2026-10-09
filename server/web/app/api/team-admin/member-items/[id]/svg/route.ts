/**
 * GET /api/team-admin/member-items/:id/svg[?node=<drawId>] : the saved SVG
 * of a shared member drawing (:id), or of a drawing the shared item :id
 * embeds (`node`, in its bundle and itself shared with the team). :id must
 * be an active member's item shared with the team; read at team level. Rendered as
 * an image, never as markup; the sandbox CSP covers a direct open. Owner
 * session or the owner's `?at=` asset token.
 */
import { z } from 'zod';
import { memberDrawSvgShared } from '@mantle/content';
import { getOwnerForAsset } from '@/lib/auth';
import { SubmissionParams } from '@/lib/member-review';

const Node = z.string().uuid();

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerForAsset(req);
  if (user instanceof Response) return user;
  const params = SubmissionParams.safeParse(await ctx.params);
  const node = Node.safeParse(new URL(req.url).searchParams.get('node') ?? params.data?.id);
  const svg =
    params.success && node.success ? await memberDrawSvgShared(params.data.id, node.data) : null;
  if (!svg) {
    return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  }
  return new Response(svg, {
    status: 200,
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=300',
    },
  });
}
