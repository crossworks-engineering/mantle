/**
 * DELETE /api/fleet/boxes/:id: stop every call to a box
 * (docs/control-center.md). What was done on the box stays as it is; the
 * box owner unlinks from the box side by removing its two .env lines. Not a
 * CC: 404.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { removeControlBox } from '@mantle/db';
import { ownerCaller } from '@/lib/auth';
import { fleetOff } from '@/lib/control/fleet';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  DELETE: {
    class: 'area',
    area: 'settings',
    item: { none: "manages the Control Center's box list: the Admin step checks it" },
  },
});

const IdParams = z.object({ id: z.string().uuid() });

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  ownerCaller();
  const off = fleetOff();
  if (off) return off;
  const id = IdParams.safeParse(await ctx.params);
  if (!id.success) return NextResponse.json({ error: 'Invalid box id.' }, { status: 400 });
  if (!(await removeControlBox(id.data.id.toLowerCase()))) {
    return NextResponse.json({ error: 'Box not found.' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
