/**
 * POST /api/fleet/bans/:id/lift: lift a fleet ban (docs/control-center.md).
 * A disable ban: the next run re-enables, on each box, the logins this ban
 * disabled that no other active ban matches, and only while the box's own
 * marker says the CC disabled them (never a login a box Admin disabled by
 * hand). An archive ban is retired: its runs stop and nothing is enabled.
 * Not a CC: 404.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { liftControlBan } from '@mantle/db';
import { ownerCaller } from '@/lib/auth';
import { fleetOff } from '@/lib/control/fleet';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'area',
    area: 'settings',
    item: { none: "manages the Control Center's bans: the Admin step checks it" },
  },
});

const IdParams = z.object({ id: z.string().uuid() });

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const off = fleetOff();
  if (off) return off;
  const id = IdParams.safeParse(await ctx.params);
  if (!id.success) return NextResponse.json({ error: 'Invalid ban id.' }, { status: 400 });
  const ban = await liftControlBan(id.data.id.toLowerCase(), user.actor.email);
  if (!ban) return NextResponse.json({ error: 'No active ban with that id.' }, { status: 404 });
  return NextResponse.json({ ban });
}
