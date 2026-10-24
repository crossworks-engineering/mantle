import { contactCodeRequired, gateShare } from '@/lib/contact-share-gate';
import { isEmbeddedPresentAllowed } from '@/lib/shares';
import { getPresentPoster } from '@/lib/presents';
import { CACHE_CONTROL } from '@/lib/cache-control';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'link', limits: { rateLimit: ['sharePresentEmbed'] } },
});

/**
 * The snapshot of a Present canvas EMBEDDED in a shared page or note, as a
 * PNG: the picture only. A link never opens the canvas itself (no frame,
 * no source; docs/proposals/canvas-files.md section 7.2 keeps a canvas's
 * live share for later).
 *
 * Authorization mirrors `/s/:token/draw/:drawId` (isEmbeddedPresentAllowed):
 * the token must be active, the id must be placed by the shared page's own
 * doc or the shared note's own markdown, and the link must serve it (the
 * owner put it on the served list). So a share never becomes a way to read
 * arbitrary canvases by id. Never a render: anonymous share traffic spends
 * no sidecar time; the poster is drawn when the canvas is saved.
 */

function notFound() {
  return new Response('Not found', {
    status: 404,
    headers: { 'Cache-Control': CACHE_CONTROL.none },
  });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string; presentId: string }> },
) {
  const { token, presentId } = await params;

  // The gate took the row's per-address limit (lib/route-limits.ts sharePresentEmbed).

  const gate = await gateShare(req, token);
  if (gate.kind === 'code') return contactCodeRequired(gate.share);
  const share = gate.kind === 'ok' ? gate.share : null;
  if (!share || !(await isEmbeddedPresentAllowed(share, presentId))) return notFound();

  const poster = await getPresentPoster(share.ownerId, presentId);
  if (!poster) return notFound();

  return new Response(new Uint8Array(poster.png), {
    status: 200,
    headers: {
      'content-type': 'image/png',
      'x-content-type-options': 'nosniff',
      'Cache-Control': CACHE_CONTROL.private5m,
    },
  });
}
