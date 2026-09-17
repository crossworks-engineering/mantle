import { NextResponse } from '@/server/http-compat';
import { getOwnerForAsset } from '@/lib/auth';
import { getDrawSvg } from '@mantle/content';
import { getDrawSvgOrRender } from '@/lib/draw-snapshot';

/**
 * The committed SVG snapshot, in two shapes:
 *
 *   (default)  JSON `{ svg }` — so apiFetch's bearer carries it in the split
 *              deployment, where an image element's src cannot. The list
 *              preview turns the string into a blob URL.
 *   ?raw=1     the bytes, as `image/svg+xml` — what a page that EMBEDS this
 *              drawing points its <img> at. A detached client authenticates
 *              with the short-lived `?at=` asset token (hence
 *              getOwnerForAsset), the same way export downloads do.
 *
 * Either way the snapshot is rendered AS AN IMAGE, never injected as markup.
 * The sandbox CSP below covers the case where someone opens the raw URL
 * directly, which would otherwise be a top-level SVG document with scripts
 * enabled.
 *
 * Owner-authed, so this is one of the surfaces allowed to FILL the snapshot
 * cache: a drawing whose snapshot is missing or stale is re-rendered by the
 * browser sidecar on first view.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerForAsset(req);
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const url = new URL(req.url);
  // `nofill=1` = read the cache, never render. The print surface sets it
  // because that page is ITSELF loaded by the browser sidecar: a render
  // triggered from there would need a second sidecar session while the first
  // is still blocked waiting for this image, and with CONCURRENT=2 two
  // simultaneous exports would deadlock until the session timeout. The export
  // route warms the cache before printing instead.
  const svg =
    url.searchParams.get('nofill') === '1'
      ? await getDrawSvg(user.id, id)
      : await getDrawSvgOrRender(user.id, id);

  if (url.searchParams.get('raw') !== '1') {
    return NextResponse.json({ svg });
  }
  if (!svg)
    return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
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
