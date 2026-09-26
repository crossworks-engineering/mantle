import { z } from 'zod';
import { withSpace, withTeamDrafts, withViewer } from '@mantle/db';
import { getDrawSvg, getTeamDraftDrawSvg } from '@mantle/content';
import { getMemberForAsset } from '@/lib/auth';

const IdParams = z.object({ id: z.string().uuid() });

/**
 * GET /api/member/draws/:id/svg : a drawing's committed SVG snapshot for a
 * MEMBER, as an image (member logins, Phase 1). Never the scene or the draft.
 * Looked up in the three places a member may read, each under its own row
 * rules: the Library (team level), the member's own space (Phase 2), then
 * teammates' team-shared drawings. Anything else is a 404. No render
 * fallback: a drawing with no snapshot yet shows as missing until it is saved.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = await getMemberForAsset(req);
  if (member instanceof Response) return member;
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return new Response('Invalid id', { status: 400 });
  const id = idParsed.data.id;
  const svg =
    (await withViewer('team', () => getDrawSvg(member.anchorId, id))) ??
    (await withSpace({ spaceId: member.spaceId, loginId: member.loginId }, () =>
      getDrawSvg(member.spaceId, id),
    )) ??
    (await withTeamDrafts(() => getTeamDraftDrawSvg(id)));
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
