/**
 * POST /api/fleet/boxes { url, label? }: link a subject box to this
 * Control Center (docs/control-center.md). The Admin types the URL (https,
 * no path); nothing from a box ever changes it. Its first run is asked for
 * at once; it shows "linked" once the box answers a signed call, which
 * needs the two .env lines on the box. Not a CC: 404.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { addControlBox, checkBoxUrl } from '@mantle/db';
import { ConflictError, InputError } from '@mantle/std';
import { ownerCaller } from '@/lib/auth';
import { fleetOff } from '@/lib/control/fleet';
import { readBody } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'area',
    area: 'settings',
    item: { none: "manages the Control Center's box list: the Admin step checks it" },
  },
});

const Body = z.object({ url: z.string().max(400), label: z.string().max(100).nullish() }).strict();

export async function POST(req: Request) {
  const user = ownerCaller();
  const off = fleetOff();
  if (off) return off;
  const body = await readBody(req, Body);
  const url = checkBoxUrl(body.url);
  if (!url.ok) throw new InputError(url.error);
  const box = await addControlBox(url.value, body.label ?? null, user.actor.email);
  if (!box) throw new ConflictError('That box is already linked.');
  return NextResponse.json({ box }, { status: 201 });
}
