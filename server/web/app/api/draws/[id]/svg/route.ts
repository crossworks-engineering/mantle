import { NextResponse } from '@/server/http-compat';
import { readerAssetCaller } from '@/lib/auth';
import { getDrawSvg, scopedDrawSvg } from '@mantle/content';
import { isUuid } from '@mantle/std';
import { getDrawSvgOrRender } from '@/lib/draw-snapshot';
import { CACHE_CONTROL } from '@/lib/cache-control';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'content', open: 'owner' },
});

/**
 * The committed SVG snapshot, in two shapes:
 *
 *   (default)  JSON `{ svg }` — so apiFetch's bearer carries it in the split
 *              deployment, where an image element's src cannot. The list
 *              preview turns the string into a blob URL.
 *   ?raw=1     the bytes, as `image/svg+xml` — what a page that EMBEDS this
 *              drawing points its <img> at. A detached client authenticates
 *              with the short-lived `?at=` asset token (the asset
 *              answer the gate gives), the same way export downloads do.
 *
 * Either way the snapshot is rendered AS AN IMAGE, never injected as markup.
 * The sandbox CSP below covers the case where someone opens the raw URL
 * directly, which would otherwise be a top-level SVG document with scripts
 * enabled.
 *
 * Owner-authed, so this is one of the surfaces allowed to FILL the snapshot
 * cache: a drawing whose snapshot is missing or stale is re-rendered by the
 * browser sidecar on first view.
 *
 * Every login (readerAssetCaller: the gate's answer of
 * getReaderForAsset): a member reads a drawing its
 * workspaces hold, the cache only, with only the images it may read; a
 * drawing it does not read is a 404 (raw) or `{ svg: null }` (JSON), the
 * same answer as an id no row has.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const reader = readerAssetCaller();
  const user = reader.user;
  const { id } = await ctx.params;
  if (!isUuid(id)) return new Response('Invalid id', { status: 400 });
  const url = new URL(req.url);
  // `nofill=1` = read the cache, never render. The print surface sets it
  // because that page is ITSELF loaded by the browser sidecar: a render
  // triggered from there would need a second sidecar session while the first
  // is still blocked waiting for this image, and with CONCURRENT=2 two
  // simultaneous exports would deadlock until the session timeout. The export
  // route warms the cache before printing instead.
  //
  // A member reads the cache only, in its own scope, and gets only the
  // images whose file its workspaces read (an Admin image in a shared
  // drawing is taken out, its frame shows empty).
  const cached =
    reader.member || url.searchParams.get('nofill') === '1'
      ? await getDrawSvg(user.id, id)
      : await getDrawSvgOrRender(user.id, id, { actorId: user.actor.id });
  const svg = reader.member && cached ? await scopedDrawSvg(user.id, id, cached) : cached;

  if (url.searchParams.get('raw') !== '1') {
    return NextResponse.json({ svg });
  }
  if (!svg) return new Response('Not found', { status: 404 });
  return new Response(svg, {
    status: 200,
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      'x-content-type-options': 'nosniff',
      // A member's bytes were read in its scope, which a Moderator may
      // narrow at any time: a cache revalidates before reuse.
      'Cache-Control': reader.member ? CACHE_CONTROL.privateRevalidate : CACHE_CONTROL.private5m,
    },
  });
}
