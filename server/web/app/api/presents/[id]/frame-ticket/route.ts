/**
 * POST /api/presents/[id]/frame-ticket: mint the seconds-lived ticket the
 * canvas iframe presents to GET /api/presents/[id]/frame (an iframe
 * navigation carries no cookie and no bearer, so THIS session-authed call is
 * where the login authenticates; docs/proposals/canvas-files.md 5.2).
 *
 * The canvas is read first, in the caller's scope: a canvas the login does
 * not read is a 404 and gets no ticket. An Admin user's ticket names the
 * admin login, any other login's its login; the frame re-checks either (a
 * login that is not an active member is refused there, as with apps).
 */
import { NextResponse } from '@/server/http-compat';
import { buildCanvasFrameTicket, ownerLoginCaller } from '@/lib/auth';
import { adminFacts } from '@/lib/auth/login';
import { getPresent } from '@/lib/presents';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  POST: {
    class: 'content',
    effect: {
      read: "a canvas's frame ticket: it reads the canvas and mints a ticket, it stores nothing",
    },
    open: 'owner',
    limits: { rateLimit: ['memberCanvasFrameTicket'] },
  },
});

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const login = ownerLoginCaller();
  const { id } = await ctx.params;
  const admin = (await adminFacts(login)).admin;
  const present = await getPresent(login.brainId, id);
  if (!present) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const ticket = admin
    ? buildCanvasFrameTicket({
        ownerId: login.brainId,
        presentId: present.id,
        actorId: login.actor.id,
      })
    : buildCanvasFrameTicket({
        ownerId: login.brainId,
        presentId: present.id,
        loginId: login.loginId,
      });
  return NextResponse.json({ ticket, rev: present.rev });
}
