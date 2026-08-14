/**
 * GET /s/[token]/frame — the SHARE-surface sandbox frame document. Auth is the
 * `?t=` frame ticket minted by POST /s/[token]/frame-ticket; the ticket binds
 * to THIS share (claims.shareId), and the share is re-resolved so a revocation
 * inside the ticket's short life still cuts access. Published build only —
 * a share never serves a draft.
 */
import { NextResponse } from '@/server/http-compat';
import { resolveActiveShareByToken } from '@/lib/shares';
import { verifyAppFrameTicket } from '@/lib/auth';
import { getApp, isTeamMember, shareModeOf } from '@mantle/content';
import { renderAppFrame } from '@/lib/app-frame';

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const share = await resolveActiveShareByToken(token);
  if (!share || share.nodeType !== 'app') return new NextResponse('not found', { status: 404 });

  const t = new URL(req.url).searchParams.get('t');
  const ticket = t ? verifyAppFrameTicket(t) : null;
  if (!ticket || ticket.shareId !== share.id || ticket.appId !== share.nodeId) {
    return new NextResponse('frame ticket required', { status: 401 });
  }
  // Team liveness, the same doctrine as every broker call: the ticket proves
  // who the visitor WAS at mint time; membership must still hold NOW. A share
  // flipped to team mode after a public mint also lands here (no contactId ⇒
  // refuse) rather than serving the bundle to a now-ungated visitor.
  if (shareModeOf(share) === 'team') {
    if (!ticket.contactId || !(await isTeamMember(share.ownerId, ticket.contactId))) {
      return new NextResponse('team session required', { status: 401 });
    }
  }

  const app = await getApp(share.ownerId, share.nodeId);
  const build = app?.publishedBuild?.ok ? app.publishedBuild : null;
  if (!build) return new NextResponse('no build', { status: 404 });

  return renderAppFrame(req, build);
}
