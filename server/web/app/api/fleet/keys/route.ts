/**
 * GET /api/fleet/keys: key status on the fleet (docs/control-center.md,
 * "Key status on the fleet"): per box, the CC's own box first (`self`), one
 * line for each provider key it holds: the service, when it was set, its
 * last test and what that means (`state`), and a short print of the key to
 * match it with the provider's dashboard. Never a key. A linked box's lines
 * are from its last good facts read (`at`, every 5 minutes); `keysReason`
 * says why a box has none (old-box, scope, no-facts). A person's screen:
 * the MCP tool control_key_status gives the same without the prints.
 *
 * POST /api/fleet/keys: set or replace one provider key on the fleet
 * (docs/control-center.md, "Set a provider key on the fleet"). Body: the
 * service (e.g. openrouter), the key, and optional box ids (default every
 * linked box). Each box is queued and run at once: the control service
 * sends the key, the box sets it as its Keys screen does, tests it and
 * answers ok or a reason. The CC holds the key sealed until it is sent
 * (seconds), an hour at most. The
 * answer names the boxes queued, never the key. Not a CC: 404, with no CC
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
  GET: { class: 'area', area: 'settings' },
  POST: {
    class: 'area',
    area: 'settings',
    item: { none: "sets a provider key on the Control Center's boxes: the Admin step checks it" },
  },
});

const Body = z
  .object({
    service: z.string().max(64),
    value: z.string().max(8192),
    boxIds: z.array(z.string().uuid()).max(500).optional(),
  })
  .strict();

export async function GET() {
  const user = ownerCaller();
  const off = ccOff();
  if (off) return off;
  const [{ keptKeyBox, listControlKeys, selfKeyBox }, { keyLines }] = await Promise.all([
    import('@mantle/db/control-center'),
    import('@mantle/api-keys'),
  ]);
  // The CC's own box first, read now (its keys' owner is the brain's anchor).
  const [self, rows] = await Promise.all([keyLines(user.id), listControlKeys()]);
  return NextResponse.json({ boxes: [selfKeyBox(self), ...rows.map(keptKeyBox)] });
}

export async function POST(req: Request) {
  const user = ownerCaller();
  const off = ccOff();
  if (off) return off;
  const [{ checkKeyInput, controlKeyAad, queueControlKey }, { seal }] = await Promise.all([
    import('@mantle/db/control-center'),
    import('@mantle/crypto'),
  ]);
  const body = await readBody(req, Body);
  const k = checkKeyInput(body);
  if (!k.ok) throw new InputError(k.error);
  const queued = await queueControlKey(
    k.value.service,
    (boxId) => seal(k.value.value, controlKeyAad(boxId)).ciphertext.toString('base64'),
    user.actor.email,
    body.boxIds?.map((id) => id.toLowerCase()),
  );
  return NextResponse.json({ service: k.value.service, queued: queued.length, boxIds: queued });
}
