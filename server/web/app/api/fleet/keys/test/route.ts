/**
 * POST /api/fleet/keys/test: "Test now" for key status on the fleet
 * (docs/control-center.md, "Key status on the fleet"). Body: optional
 * `boxIds` (box ids, and `self` for the CC's own box); left out, the CC's
 * own box and every linked box. Each box tests the provider keys it holds
 * (its own fixed case, keyTest, sent by the control service in the box's
 * run, asked for at once; the CC's own box in process) and answers its
 * fresh lines. Waits up to 25 seconds, then answers each box asked: its
 * lines and `tested` (`ok`, or a reason: scope, bad-call from a box a
 * release behind, unreachable, busy, pending). A box still pending shows
 * its fresh lines in GET /api/fleet/keys once its run is done. A failed
 * test changes nothing on a box. The CC's own box is tested only for a
 * person with the vault's own area, keys (else `keys-area`). Its own rate
 * limit, fleetKeyTest; a box runs one key test at a time. Not a CC: 404,
 * with no CC code loaded.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { ccOff } from '@/lib/control/env';
import { readBody } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';
import type { FleetKeyTestAnswer } from '@mantle/client-types';

export const policy = routePolicy({
  POST: {
    class: 'area',
    area: 'settings',
    item: {
      none: "tests the provider keys on the Control Center's boxes: the Admin step checks it",
    },
    limits: { rateLimit: ['fleetKeyTest'] },
  },
});

const Body = z
  .object({
    boxIds: z
      .array(z.union([z.literal('self'), z.string().uuid()]))
      .min(1)
      .max(500)
      .optional(),
  })
  .strict();

export async function POST(req: Request) {
  const user = ownerCaller();
  const off = ccOff();
  if (off) return off;
  const [cc, { ownKeyLines }] = await Promise.all([
    import('@mantle/db/control-center'),
    import('@mantle/api-keys'),
  ]);
  const body = await readBody(req, Body);
  const withSelf = !body.boxIds || body.boxIds.includes(cc.CONTROL_SELF);
  const linked = body.boxIds?.filter((id) => id !== cc.CONTROL_SELF);
  const by = user.actor.email;
  const [self, tests] = await Promise.all([
    // The CC's own box in process: its keys tested as this person, through
    // the vault's own test (its gate, its audit row).
    withSelf ? ownKeyLines(user.id, { loginId: user.actor.id, email: by, via: 'web' }) : null,
    linked && linked.length === 0 ? [] : cc.askControlKeyTests(linked, by),
  ]);
  const boxes: FleetKeyTestAnswer['boxes'] = await cc.keyTestBoxes(self, tests);
  return NextResponse.json({ boxes } satisfies FleetKeyTestAnswer);
}
