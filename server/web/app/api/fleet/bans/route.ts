/**
 * POST /api/fleet/bans: a fleet ban (docs/control-center.md). Keys: emails
 * (matched lowercase, exact) and an optional company sign-in issuer plus
 * object id. kind 'disable' (the CC can lift it) or 'archive' (a permanent
 * disable: only a box Admin undoes it, by hand). With `preview: true` it
 * makes nothing and answers what the ban would match on each box, from
 * each box's last login list. Else it makes the ban and asks for a run of
 * every box at once. Not a CC: 404.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { InputError } from '@mantle/std';
import { ownerCaller } from '@/lib/auth';
import { ccOff } from '@/lib/control/env';
import { readBody } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'area',
    area: 'settings',
    item: { none: "manages the Control Center's bans: the Admin step checks it" },
  },
});

const Body = z
  .object({
    kind: z.enum(['disable', 'archive']).optional(),
    emails: z.array(z.string().max(254)).max(50).optional(),
    issuer: z.string().max(300).nullish(),
    oid: z.string().max(128).nullish(),
    reason: z.string().max(500).nullish(),
    preview: z.boolean().optional(),
  })
  .strict();

export async function POST(req: Request) {
  const user = ownerCaller();
  const off = ccOff();
  if (off) return off;
  const { checkBan, makeControlBan, previewControlBan } = await import('@mantle/db/control-center');
  const body = await readBody(req, Body);
  const ban = checkBan(body);
  if (!ban.ok) throw new InputError(ban.error);
  if (body.preview) return NextResponse.json({ preview: await previewControlBan(ban.value) });
  const row = await makeControlBan(ban.value, user.actor.email);
  return NextResponse.json({ ban: row }, { status: 201 });
}
