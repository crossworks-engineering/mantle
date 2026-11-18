/**
 * POST /api/services/:name/frame-ticket (Sync service plan M2, decision 3):
 * the ticket the client puts in the sandboxed frame that shows an optional
 * service's own screens (today the Sync account screens). The frame's
 * requests carry no cookie, so this session-authed call is where the login
 * proves itself; the screen route takes the ticket, re-checks the login's
 * area and renews it with every screen.
 *
 * The connectors area (an Admin, or a member given it), as linking a mailbox
 * or a feed was before M4. 404 for a service with no screens or one that is
 * off.
 */
import { NextResponse } from '@/server/http-compat';
import { serviceEnabled } from '@mantle/config';
import { buildServiceFrameTicket, ownerCaller } from '@/lib/auth';
import { routePolicy } from '@/lib/auth/route-declaration';
import { SCREEN_SERVICES } from '@/lib/service-screens';

export const policy = routePolicy({
  POST: {
    class: 'area',
    area: 'connectors',
    item: { none: 'manages the connectors area: the Admin step checks it' },
  },
});

export async function POST(_req: Request, ctx: { params: Promise<{ name: string }> }) {
  const user = ownerCaller();
  const { name } = await ctx.params;
  if (!SCREEN_SERVICES.includes(name as never) || !serviceEnabled(name as never)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const ticket = buildServiceFrameTicket({
    ownerId: user.id,
    service: name,
    actorId: user.actor.id,
  });
  return NextResponse.json({
    ticket,
    url: `/api/services/${name}/ui?p=%2F&t=${encodeURIComponent(ticket)}`,
  });
}
