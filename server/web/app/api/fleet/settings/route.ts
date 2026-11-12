/**
 * POST /api/fleet/settings: the fleet's other first writes (docs/control-center.md,
 * "Fleet writes"): a model pool entry, the update notice on or off, a
 * worker group, a worker's model. Body: 1 to 20 changes, each `{ kind:
 * 'poolEntry', pool, name, vendor?, routes }`, `{ kind: 'updateNotice', on
 * }`, `{ kind: 'workerGroup', slug, name?, members, enabled? }` or `{ kind:
 * 'workerModel', worker, provider, endpoint, model }`, and optional box ids
 * (default every linked box). Each box is queued and run at once: the
 * control service sends each change once, the box runs its own path after
 * its own check and answers ok and what it had, or a reason. Changes join
 * what waits for a box (agent models too); a box with 40 waiting is not
 * queued. Not a CC: 404, with no CC code loaded.
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
    item: {
      none: "sets pool entries, the update notice, worker groups and worker models on the Control Center's boxes: the Admin step checks it",
    },
  },
});

const Body = z
  .object({
    // Each change's shape is the store's check (checkSettingChanges).
    changes: z.array(z.record(z.string(), z.unknown())).max(20),
    boxIds: z.array(z.string().uuid()).max(500).optional(),
  })
  .strict();

export async function POST(req: Request) {
  const user = ownerCaller();
  const off = ccOff();
  if (off) return off;
  const { checkSettingChanges, queueControlWrites } = await import('@mantle/db/control-center');
  const body = await readBody(req, Body);
  const c = checkSettingChanges(body.changes);
  if (!c.ok) throw new InputError(c.error);
  const queued = await queueControlWrites(
    c.value,
    user.actor.email,
    body.boxIds?.map((id) => id.toLowerCase()),
  );
  return NextResponse.json({ changes: c.value, queued: queued.length, boxIds: queued });
}
