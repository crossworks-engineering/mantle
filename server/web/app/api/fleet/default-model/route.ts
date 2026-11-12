/**
 * /api/fleet/default-model: the Control Center's Default Model
 * (docs/control-center.md, "Default Model"). GET answers the stored
 * provider and key (the key by id, name and masked hint, never its value),
 * whether that key is still there, and the chat providers and keys this
 * brain can pick from. PUT `{ provider, keyId }` sets it after checking the
 * key is this brain's key for that provider; DELETE clears it. The Fleet
 * screen lists the models with GET /api/models?provider&keyId. The same
 * acts over MCP: control_default_model_get and control_default_model_set.
 * Not a CC: 404.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { readFleetDefaultModel, setFleetDefaultModel } from '@mantle/tools/fleet-default-model';
import { ownerCaller } from '@/lib/auth';
import { ccOff } from '@/lib/control/env';
import { readBody } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'settings' },
  PUT: {
    class: 'area',
    area: 'settings',
    item: {
      none: "sets the Control Center's Default Model, a brain setting: the Admin step checks it",
    },
  },
  DELETE: {
    class: 'area',
    area: 'settings',
    item: {
      none: "sets the Control Center's Default Model, a brain setting: the Admin step checks it",
    },
  },
});

const Body = z
  .object({
    provider: z.string().min(1).max(64),
    keyId: z.string().uuid(),
  })
  .strict();

export async function GET() {
  const user = ownerCaller();
  const off = ccOff();
  if (off) return off;
  return NextResponse.json(await readFleetDefaultModel(user.id));
}

export async function PUT(req: Request) {
  const user = ownerCaller();
  const off = ccOff();
  if (off) return off;
  const body = await readBody(req, Body);
  return NextResponse.json(await setFleetDefaultModel(user.id, body));
}

export async function DELETE() {
  const user = ownerCaller();
  const off = ccOff();
  if (off) return off;
  return NextResponse.json(await setFleetDefaultModel(user.id, null));
}
