import { contactCodeRequired, gateShare } from '@/lib/contact-share-gate';
import { isDrawServable, shareLevels } from '@/lib/shares';
import { db, nodes } from '@mantle/db';
import { and, eq } from 'drizzle-orm';
import { getDrawSvg } from '@mantle/content';
import { rateLimit, clientIp } from '@/lib/rate-limit';

/**
 * The committed SVG snapshot of a shared drawing, as its own image response.
 *
 * The presenter references this with `<img src>` rather than injecting the
 * markup into the page, and that is the whole point: an SVG loaded as an image
 * is a separate, script-disabled document. Scripts don't run, inline `<style>`
 * can't reach the host page, and external subresources don't load — so the
 * safety of the share surface no longer depends on a validator correctly
 * predicting every hostile construct. acceptSceneSvg still runs at commit as a
 * second layer; neither one is load-bearing alone.
 *
 * Authorization mirrors /s/:token/a/:fileId exactly: the token must be active,
 * and the node behind the token must actually be a draw (getDrawSvg filters
 * ownerId + type). Uniform 404 so a URL never reveals that a token exists.
 * The snapshot carries the drawing's images, so every image it places must
 * sit at the link's levels (linkLevels): one an admin raised above the
 * drawing on purpose keeps the snapshot off the link.
 */

function notFound() {
  return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
}

export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const { ok, retryAfterSec } = rateLimit(`share-draw:${clientIp(req)}`, {
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
  if (!share) return notFound();
  const [node] = await db
    .select({ audience: nodes.audience })
    .from(nodes)
    .where(and(eq(nodes.id, share.nodeId), eq(nodes.ownerId, share.ownerId)))
    .limit(1);
  if (!node) return notFound();
  if (
    !(await isDrawServable(share.ownerId, share.nodeId, shareLevels(share, node.audience), {
      self: false,
    }))
  ) {
    return notFound();
  }

  const svg = await getDrawSvg(share.ownerId, share.nodeId);
  if (!svg) return notFound();

  return new Response(svg, {
    status: 200,
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      // Belt and braces for the case this URL is opened DIRECTLY rather than
      // through the <img>: as a top-level document an SVG would otherwise run
      // its own scripts. `sandbox` (no allow-scripts) plus a null default-src
      // makes that inert too.
      'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=300',
    },
  });
}
