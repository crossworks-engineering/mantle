/**
 * GET /api/sidecar/state?prefix= (Sync service plan M2; lib/sidecar.ts):
 * the Sync sidecar's state values whose key starts with `prefix`, opened.
 * The sidecar keeps no disk: its accounts, feeds and cursors live here.
 */
import { NextResponse } from '@/server/http-compat';
import { listServiceState } from '@mantle/db';
import { routePolicy } from '@/lib/auth/route-declaration';
import { SIDECAR_SERVICE, asSidecar, openState, sidecarRequestRefusal } from '@/lib/sidecar';

export const policy = routePolicy({
  // No rate limit, as the gateway's routes (gateway/registry/route.ts says
  // why): the token is checked first and a refusal does no work.
  GET: { class: 'public' },
});

const PREFIX_RE = /^[a-z0-9:._-]{0,200}$/;

export async function GET(req: Request) {
  const refused = sidecarRequestRefusal(req);
  if (refused) return refused;
  const prefix = new URL(req.url).searchParams.get('prefix') ?? '';
  if (!PREFIX_RE.test(prefix)) return NextResponse.json({ error: 'bad prefix' }, { status: 400 });
  const rows = await asSidecar(() => listServiceState(SIDECAR_SERVICE, prefix));
  return NextResponse.json({
    values: rows.map((r) => ({ key: r.key, value: openState(r.key, r.value) })),
  });
}
