/**
 * POST /s/[token]/frame-ticket — mint the seconds-lived signed ticket the
 * sandbox iframe presents to GET /s/[token]/frame. The VISITOR authenticates
 * here exactly as for /bundle (public share: anyone; team share: a live team
 * credential — cookie same-origin, bearer from the split client's hub); the
 * frame navigation itself then carries only the ticket, because a sandboxed
 * iframe sends no cookies and an iframe src can't attach a bearer.
 * 404 when the app has no published build.
 */
import { NextResponse } from '@/server/http-compat';
import { resolveActiveShareByToken } from '@/lib/shares';
import { resolveShareVisitorFromRequest } from '@/lib/team-gate';
import { buildAppFrameTicket } from '@/lib/auth';
import { getApp } from '@mantle/content';

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const share = await resolveActiveShareByToken(token);
  if (!share || share.nodeType !== 'app') return new NextResponse('not found', { status: 404 });

  const visitor = await resolveShareVisitorFromRequest(req, share);
  if (!visitor) return new NextResponse('team session required', { status: 401 });

  const app = await getApp(share.ownerId, share.nodeId);
  if (!app?.publishedBuild?.ok) return new NextResponse('no build', { status: 404 });

  return NextResponse.json({
    ticket: buildAppFrameTicket({
      ownerId: share.ownerId,
      appId: share.nodeId,
      shareId: share.id,
    }),
  });
}
