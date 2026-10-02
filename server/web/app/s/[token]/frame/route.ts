/**
 * GET /s/[token]/frame — the SHARE-surface sandbox frame document. Auth is the
 * `?t=` frame ticket minted by POST /s/[token]/frame-ticket; the ticket binds
 * to THIS share (claims.shareId), and the share is re-resolved so a revocation
 * inside the ticket's short life still cuts access. On a contact share the
 * ticket also names the contact and its code epoch, re-checked here. Published build only —
 * a share never serves a draft.
 */
import { NextResponse } from '@/server/http-compat';
import { resolveActiveShareRowByToken } from '@/lib/shares';
import { contactTicketAdmits } from '@/lib/contact-share-gate';
import { verifyAppFrameTicket } from '@/lib/auth';
import { getApp } from '@mantle/content';
import { renderAppFrame } from '@/lib/app-frame';

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const share = await resolveActiveShareRowByToken(token);
  if (!share) return new NextResponse('not found', { status: 404 });

  const t = new URL(req.url).searchParams.get('t');
  const ticket = t ? verifyAppFrameTicket(t) : null;
  const forThisShare = !!ticket && ticket.shareId === share.id && ticket.appId === share.nodeId;
  // A contact share without a ticket of its own answers 401 whatever its
  // kind, like every other /s route behind the contact gate.
  if (share.contactId && !forThisShare) {
    return new NextResponse('frame ticket required', { status: 401 });
  }
  if (share.nodeType !== 'app') return new NextResponse('not found', { status: 404 });
  if (!ticket || !forThisShare) {
    return new NextResponse('frame ticket required', { status: 401 });
  }
  // A contact share: the ticket must name this share's contact at the
  // contact's current code epoch, with sharing on and not locked (the
  // navigation carries no cookie, so the gate is re-run on the ticket). An
  // open link refuses a ticket that names a contact.
  if (!(await contactTicketAdmits(share, ticket))) {
    return new NextResponse('frame ticket required', { status: 401 });
  }

  const app = await getApp(share.ownerId, share.nodeId);
  const build = app?.publishedBuild?.ok ? app.publishedBuild : null;
  if (!build) return new NextResponse('no build', { status: 404 });

  // Shared surface: the Neat backdrop honours the shareNeat switch here.
  // host.me(): the share's contact, or nobody on an open link.
  return renderAppFrame(req, build, {
    shared: true,
    viewer: {
      ownerId: share.ownerId,
      appId: share.nodeId,
      subject: share.contactId
        ? { kind: 'contact', contactId: share.contactId }
        : { kind: 'public' },
    },
  });
}
