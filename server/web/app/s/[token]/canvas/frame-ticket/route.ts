/**
 * POST /s/[token]/canvas/frame-ticket: mint the seconds-lived ticket the
 * canvas iframe of an open link presents to GET /s/[token]/canvas/frame
 * (docs/proposals/canvas-files.md 5.3 and 7.2). The visitor needs the active
 * link and nothing else; the ticket binds the frame to THIS link and canvas.
 * Only an open link: a Present canvas carries no contact share, so a link
 * with a contact is not one this route serves. 404 when the canvas is gone.
 */
import { NextResponse } from '@/server/http-compat';
import { gateShare } from '@/lib/contact-share-gate';
import { buildCanvasFrameTicket, canvasFrameNonce } from '@/lib/auth';
import { getPresentFrame } from '@/lib/presents';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'link',
    item: { none: 'a link route: its share token names what it opens' },
    limits: { rateLimit: ['shareCanvasFrameTicket'] },
  },
});

// A POST answer is never cached, so no Cache-Control is set (as the app's
// share frame ticket).
function notFound() {
  return new NextResponse('not found', { status: 404 });
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const gate = await gateShare(req, token);
  if (gate.kind !== 'ok') return notFound();
  const share = gate.share;
  if (share.nodeType !== 'present' || share.contactId) return notFound();
  const canvas = await getPresentFrame(share.ownerId, share.nodeId);
  if (!canvas) return notFound();
  const ticket = buildCanvasFrameTicket({
    ownerId: share.ownerId,
    presentId: share.nodeId,
    shareId: share.id,
  });
  // The nonce lets the parent tell the frame it asked for from a page the
  // canvas navigated to (canvas-sandbox.tsx).
  // `assets`: the files the parent may ask the link's asset route for, the
  // link's served list of the last save (`meta.linkAssets`), which the route
  // checks again (isAssetAllowed). A canvas's media is part of the canvas,
  // so a link always serves that list.
  return NextResponse.json({
    ticket,
    nonce: canvasFrameNonce(ticket),
    assets: canvas.meta.linkAssets ?? [],
  });
}
