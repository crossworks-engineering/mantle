/**
 * DELETE /api/fleet/boxes/:id: stop every call to a box
 * (docs/control-center.md). What was done on the box stays as it is; the
 * box owner unlinks from the box side by removing its two .env lines. Not a
 * CC: 404.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { ccOff } from '@/lib/control/env';
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
  const off = ccOff();
  if (off) return off;
  const { removeControlBox } = await import('@mantle/db/control-center');
  const id = IdParams.safeParse(await ctx.params);
  if (!id.success) return NextResponse.json({ error: 'Invalid box id.' }, { status: 400 });
  if (!(await removeControlBox(id.data.id.toLowerCase()))) {
    return NextResponse.json({ error: 'Box not found.' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
