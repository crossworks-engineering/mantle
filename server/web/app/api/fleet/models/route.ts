/**
 * POST /api/fleet/models: set the model of agents the system ships on the
 * fleet (docs/control-center.md, "Set an agent's model on the fleet").
 * Body: 1 to 20 changes `{ slug, model, provider?, endpoint? }` (e.g. coder to a
 * new model; with the source route, a box on another route refuses) and
 * optional box ids (default every linked box). Each box is queued and run
 * at once: the control service sends each change, the box sets the model
 * field only (its provider and key stay) as its Agents screen does, after
 * its own model policy, and answers ok and the model it had, or a reason.
 * Changes join what waits for a box (at most 40). Not a CC: 404, with no CC
 * code loaded.
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
    item: { none: "sets agent models on the Control Center's boxes: the Admin step checks it" },
  },
});

const Body = z
  .object({
    changes: z
      .array(
        z
          .object({
            slug: z.string().max(64),
            model: z.string().max(200),
            // The source route, both or neither (checkModelChanges).
            provider: z.string().max(64).optional(),
            endpoint: z.string().max(12).optional(),
          })
          .strict(),
      )
      .max(20),
    boxIds: z.array(z.string().uuid()).max(500).optional(),
  })
  .strict();

export async function POST(req: Request) {
  const user = ownerCaller();
  const off = ccOff();
  if (off) return off;
  const { checkModelChanges, queueControlWrites } = await import('@mantle/db/control-center');
  const body = await readBody(req, Body);
  const c = checkModelChanges(body.changes);
  if (!c.ok) throw new InputError(c.error);
  const queued = await queueControlWrites(
    c.value,
    user.actor.email,
    body.boxIds?.map((id) => id.toLowerCase()),
  );
  return NextResponse.json({ changes: c.value, queued: queued.length, boxIds: queued });
}
