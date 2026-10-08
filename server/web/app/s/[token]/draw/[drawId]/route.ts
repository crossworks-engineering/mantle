import { contactCodeRequired, gateShare } from '@/lib/contact-share-gate';
import { isEmbeddedDrawAllowed } from '@/lib/shares';
import { getDrawSvg } from '@mantle/content';
import { clientIpKey, rateLimit } from '@/lib/rate-limit';

/**
 * A drawing EMBEDDED in a shared page or note, as an image.
 *
 * The sibling `/s/:token/draw` serves a drawing that is itself the shared
 * node; this one serves a drawing a shared *page* or *note* places with
 * `![alt](draw:<id>)`. Authorization mirrors `/s/:token/a/:fileId` exactly
 * (isEmbeddedDrawAllowed): the token must be active, and the id must appear
 * in the shared page's own doc or the shared note's own markdown, so a share
 * never becomes a way to read arbitrary drawings by id. The drawing and every
 * image its snapshot carries must sit at the link's levels (linkLevels): one
 * an admin raised above the page or note on purpose is not served.
 *
 * Cache-only, deliberately. Rendering a missing snapshot spawns a browser, and
 * anonymous share traffic does not get to do that (see
 * docs/draw-render-fallback-plan.md §4.4); the owner or the `draws:re-render`
 * task fills it instead.
 */

function notFound() {
  return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string; drawId: string }> },
) {
  const { token, drawId } = await params;

  const { ok, retryAfterSec } = rateLimit(`share-draw-embed:${clientIpKey(req)}`, {
    max: 240,
    windowMs: 60_000,
  });
  if (!ok) {
    return new Response('Too many requests', {
      status: 429,
      headers: { 'retry-after': String(retryAfterSec), 'cache-control': 'no-store' },
    });
  }

  const gate = await gateShare(req, token);
  if (gate.kind === 'code') return contactCodeRequired(gate.share);
  const share = gate.kind === 'ok' ? gate.share : null;
  if (!share || !(await isEmbeddedDrawAllowed(share, drawId))) return notFound();

  const svg = await getDrawSvg(share.ownerId, drawId);
  if (!svg) return notFound();

  return new Response(svg, {
    status: 200,
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      // As with every other snapshot surface: inert if opened directly.
      'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=300',
    },
  });
}
