/**
 * GET, PUT and DELETE /api/sidecar/state/:key (Sync service plan M2;
 * lib/sidecar.ts): one state value of the Sync sidecar, sealed here with the
 * master key (AAD `sync:<key>`) and kept in service_state (0380).
 */
import { NextResponse } from '@/server/http-compat';
import {
  SERVICE_STATE_MAX_BYTES,
  deleteServiceState,
  getServiceState,
  putServiceState,
} from '@mantle/db';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';
import { StateKey } from '@/lib/sidecar-schemas';
import {
  SIDECAR_SERVICE,
  asSidecar,
  openState,
  sealState,
  sidecarRequestRefusal,
} from '@/lib/sidecar';

export const policy = routePolicy({
  // No rate limit, as the gateway's routes (gateway/registry/route.ts says
  // why): the token is checked first and a refusal does no work.
  GET: { class: 'public' },
  PUT: { class: 'public', item: { none: "a public route: it judges its own credential (the Sync sidecar's token)" } },
  DELETE: { class: 'public', item: { none: "a public route: it judges its own credential (the Sync sidecar's token)" } },
});

type Ctx = { params: Promise<{ key: string }> };

async function keyOf(ctx: Ctx): Promise<string | null> {
  const parsed = StateKey.safeParse((await ctx.params).key);
  return parsed.success ? parsed.data : null;
}

export async function GET(req: Request, ctx: Ctx) {
  const refused = sidecarRequestRefusal(req);
  if (refused) return refused;
  const key = await keyOf(ctx);
  if (!key) return NextResponse.json({ error: 'bad key' }, { status: 400 });
  const sealed = await asSidecar(() => getServiceState(SIDECAR_SERVICE, key));
  if (!sealed) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ key, value: openState(key, sealed) });
}

export async function PUT(req: Request, ctx: Ctx) {
  const refused = sidecarRequestRefusal(req);
  if (refused) return refused;
  const key = await keyOf(ctx);
  if (!key) return NextResponse.json({ error: 'bad key' }, { status: 400 });
  const body = (await readJson(req, { refuseEmpty: true })) as { value?: unknown } | null;
  if (!body || typeof body !== 'object' || !('value' in body)) {
    return NextResponse.json({ error: 'send { value }' }, { status: 400 });
  }
  const sealed = sealState(key, body.value);
  if (sealed.byteLength > SERVICE_STATE_MAX_BYTES) {
    return NextResponse.json({ error: 'value too large' }, { status: 413 });
  }
  await asSidecar(() => putServiceState(SIDECAR_SERVICE, key, sealed));
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const refused = sidecarRequestRefusal(req);
  if (refused) return refused;
  const key = await keyOf(ctx);
  if (!key) return NextResponse.json({ error: 'bad key' }, { status: 400 });
  const removed = await asSidecar(() => deleteServiceState(SIDECAR_SERVICE, key));
  return NextResponse.json({ removed });
}
