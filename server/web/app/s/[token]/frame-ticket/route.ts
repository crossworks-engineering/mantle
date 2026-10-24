/**
 * POST /s/[token]/frame-ticket — mint the seconds-lived signed ticket the
 * sandbox iframe presents to GET /s/[token]/frame. The visitor needs the
 * active share, as for /bundle, and on a contact share the contact gate's
 * cookie; the frame navigation then carries the ticket, which binds it to
 * this share and app (and contact, and code epoch) for a few seconds.
 * 404 when the app has no published build.
 */
import { NextResponse } from '@/server/http-compat';
import { contactCodeRequired, gateShare } from '@/lib/contact-share-gate';
import { buildAppFrameTicket } from '@/lib/auth';
import { getAppRuntime } from '@mantle/content';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'link',
    item: { none: 'a link route: its share token names what it opens' },
    limits: { rateLimit: ['shareFrameTicket'] },
  },
});

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;

  // One ticket per frame load; a burst beyond this is a token-mint loop.
  // The gate took the row's per-address limit (lib/route-limits.ts shareFrameTicket).

  const gate = await gateShare(req, token);
  if (gate.kind === 'code') return contactCodeRequired(gate.share);
  const share = gate.kind === 'ok' ? gate.share : null;
  if (!share || share.nodeType !== 'app') return new NextResponse('not found', { status: 404 });

  const app = await getAppRuntime(share.ownerId, share.nodeId);
  if (!app?.publishedBuild?.ok) return new NextResponse('no build', { status: 404 });

  return NextResponse.json({
    ticket: buildAppFrameTicket({
      ownerId: share.ownerId,
      appId: share.nodeId,
      shareId: share.id,
      // A contact share's ticket names the contact and its code epoch: the
      // frame route re-checks both (its navigation carries no cookie).
      ...(gate.kind === 'ok' && gate.contact ? { contact: gate.contact } : {}),
    }),
  });
}
