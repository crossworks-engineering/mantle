/**
 * POST /api/fleet/tool: the admin channel (docs/control-center.md, "The
 * admin channel"). Body, one of:
 *  - `{ boxIds, name, args }`: run the tool `name` on each box (1 to 50);
 *  - `{ boxIds: [one], list: true }`: the tools that box's scope allows;
 *  - `{ callIds }`: the answers of earlier calls still on their way.
 * The CC queues each call (its args sealed until the control service takes
 * it) and asks for the boxes' run now; the service signs and sends it, the
 * box runs it within its own scope (MANTLE_CONTROL_CENTER_SCOPE). Waits up
 * to 25 seconds, then answers what came (each answer once) and the ids
 * still pending. Not a CC: 404, with no CC code loaded.
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
    item: { none: "runs a tool on the Control Center's boxes: the Admin step checks it" },
  },
});

const Body = z
  .object({
    boxIds: z.array(z.string().uuid()).max(50).optional(),
    name: z.string().max(80).optional(),
    args: z.record(z.string(), z.unknown()).optional(),
    list: z.boolean().optional(),
    callIds: z.array(z.string().uuid()).max(100).optional(),
  })
  .strict();

export async function POST(req: Request) {
  const user = ownerCaller();
  const off = ccOff();
  if (off) return off;
  const [{ askControlTools }, { seal }] = await Promise.all([
    import('@mantle/db/control-center'),
    import('@mantle/crypto'),
  ]);
  const body = await readBody(req, Body);
  const r = await askControlTools(body, user.actor.email, (plain, aad) =>
    seal(plain, aad).ciphertext.toString('base64'),
  );
  if (!r.ok) throw new InputError(r.error);
  return NextResponse.json(r.value);
}
