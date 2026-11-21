/**
 * The Control Center broadcast (docs/control-center.md, "Broadcast"):
 *  - GET: the broadcasts, newest first, each with one mark per box (`at`
 *    once the box took it, else the last failure's code), and the linked
 *    boxes (id, URL, label) to pick from.
 *  - POST `{ title?, text, boxIds? }`: one message to every person on the
 *    boxes named (default every linked box), stored once. Each box gets it
 *    in the Announcements chat, read-only, with a push. The control
 *    service's run sends it to each box with no mark yet; a box that is
 *    down gets it later. A person only: one send reaches every person in
 *    the fleet, so no tool sends it (control_broadcast drafts; its
 *    `send: true` is a person's act, packages/tools person-only-acts.ts).
 * Not a CC: 404, with no CC code loaded.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { InputError } from '@mantle/std';
import { ownerCaller } from '@/lib/auth';
import { ccOff } from '@/lib/control/env';
import { readBody } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'settings' },
  POST: {
    class: 'area',
    area: 'settings',
    item: {
      none: "sends a message to every person on the Control Center's boxes: the Admin step checks it",
    },
  },
});

const Body = z
  .object({
    // The text and title's own check is the store's (checkBroadcast).
    title: z.string().max(1000).optional(),
    text: z.string().max(20_000),
    boxIds: z.array(z.string().uuid()).min(1).max(1000).optional(),
  })
  .strict();

export async function GET() {
  ownerCaller();
  const off = ccOff();
  if (off) return off;
  const { broadcastTargets, listControlBroadcasts } = await import('@mantle/db/control-center');
  const [broadcasts, boxes] = await Promise.all([listControlBroadcasts(), broadcastTargets()]);
  return NextResponse.json({ broadcasts, boxes });
}

export async function POST(req: Request) {
  const user = ownerCaller();
  const off = ccOff();
  if (off) return off;
  const { checkBroadcast, makeControlBroadcast } = await import('@mantle/db/control-center');
  const body = await readBody(req, Body);
  const c = checkBroadcast({ title: body.title, body: body.text });
  if (!c.ok) throw new InputError(c.error);
  const made = await makeControlBroadcast(
    c.value,
    user.actor.email,
    body.boxIds?.map((id) => id.toLowerCase()),
  );
  if (!made.ok) throw new InputError(made.error);
  return NextResponse.json({ broadcast: made.value });
}
