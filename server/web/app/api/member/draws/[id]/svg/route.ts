import { z } from 'zod';
import { withViewer } from '@mantle/db';
import { getDrawSvg, scopedDrawSvg } from '@mantle/content';
import { getMemberForAsset } from '@/lib/auth';

const IdParams = z.object({ id: z.string().uuid() });

/**
 * GET /api/member/draws/:id/svg : a drawing's committed SVG snapshot for a
 * MEMBER, as an image (member logins, Phase 1). Never the scene or the draft.
 * Read in the member's request scope (W7e): a drawing its workspaces hold
 * (its private workspace holds its own drawings since W6b), with only the
 * images whose file it reads; anything else is a 404. No render fallback: a
 * drawing with no snapshot yet shows as missing until it is saved.
 *
 * @deprecated Workspaces W7e: GET /api/draws/:id/svg?raw=1 serves every
 * login in its scope (the same rule). Kept this release for an older UI; it
 * answers 410 once the UI pair has moved.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = await getMemberForAsset(req);
  if (member instanceof Response) return member;
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return new Response('Invalid id', { status: 400 });
  const id = idParsed.data.id;
  // The member's own scope: the request's (the guard entered it), or built
  // here when the handler runs outside the route loader.
  const out = await withViewer('team', { login: member.loginId }, async () => {
    const svg = await getDrawSvg(member.anchorId, id);
    return svg ? scopedDrawSvg(member.anchorId, id, svg) : null;
  });
  if (!out) {
    return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  }
  return new Response(out, {
    status: 200,
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=300',
    },
  });
}
