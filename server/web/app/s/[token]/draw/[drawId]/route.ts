import { resolveActiveShareByToken } from '@/lib/shares';
import { resolveShareVisitor } from '@/lib/team-gate';
import { getDrawSvg, getPage, referencedDrawIds } from '@mantle/content';
import { rateLimit, clientIp } from '@/lib/rate-limit';

/**
 * A drawing EMBEDDED in a shared page, as an image.
 *
 * The sibling `/s/:token/draw` serves a drawing that is itself the shared
 * node; this one serves a drawing a shared *page* places with
 * `![alt](draw:<id>)`. Authorization mirrors `/s/:token/a/:fileId` exactly:
 * the token must be active, a team-mode share needs a live visitor session,
 * and the id must appear in the shared page's own doc — a share never becomes
 * a way to read arbitrary drawings by id.
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

  const { ok, retryAfterSec } = rateLimit(`share-draw-embed:${clientIp(req)}`, {
    max: 240,
    windowMs: 60_000,
  });
  if (!ok) {
    return new Response('Too many requests', {
      status: 429,
      headers: { 'retry-after': String(retryAfterSec), 'cache-control': 'no-store' },
    });
  }

  const share = await resolveActiveShareByToken(token);
  if (!share || share.nodeType !== 'page') return notFound();
  if (!(await resolveShareVisitor(req.headers.get('cookie'), share))) return notFound();

  const page = await getPage(share.ownerId, share.nodeId);
  if (!page || !referencedDrawIds(page.doc).includes(drawId)) return notFound();

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
