/**
 * GET /s/[token]/canvas/frame: the sandbox frame document of a Present
 * canvas on an open link (docs/proposals/canvas-files.md 5.3 and 7.2). Auth
 * is the `?t=` canvas ticket from POST /s/[token]/canvas/frame-ticket, which
 * must name THIS link and its canvas. The link is resolved again on every
 * load, so closing it, or deleting the canvas, stops the next load at once.
 *
 * The same document, CSP and sandbox as the owner's frame (renderCanvasFrame):
 * no network, no bridge but `ready`, `error` and `leaving`. The latest save
 * is served (latest is latest). Never a render: no sidecar work here.
 */
import { NextResponse } from '@/server/http-compat';
import { gateShareCookie } from '@/lib/contact-share-gate';
import { canvasFrameNonce, verifyCanvasFrameTicket } from '@/lib/auth';
import { getPresentFrame } from '@/lib/presents';
import { renderCanvasFrame } from '@/lib/canvas-frame';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'link', limits: { rateLimit: ['shareCanvasFrame'] } },
});

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  // No cookie is read: the navigation of a sandboxed frame carries none, and
  // only an open link serves a canvas (no contact share).
  const gate = await gateShareCookie(null, token);
  const share = gate.kind === 'ok' ? gate.share : null;
  if (!share || share.nodeType !== 'present' || share.contactId) {
    return new NextResponse('not found', { status: 404 });
  }
  const raw = new URL(req.url).searchParams.get('t') ?? '';
  const ticket = raw ? verifyCanvasFrameTicket(raw) : null;
  // A link's ticket names this link and its canvas, and no login: a
  // member's or an Admin user's ticket opens the owner frame only.
  if (
    !ticket ||
    ticket.shareId !== share.id ||
    ticket.appId !== share.nodeId ||
    ticket.ownerId !== share.ownerId ||
    ticket.loginId ||
    ticket.actorId ||
    ticket.contactId
  ) {
    return new NextResponse('frame ticket required', { status: 401 });
  }
  const canvas = await getPresentFrame(share.ownerId, share.nodeId);
  if (!canvas) return new NextResponse('not found', { status: 404 });
  return renderCanvasFrame(req, share.ownerId, canvas, canvasFrameNonce(raw));
}
