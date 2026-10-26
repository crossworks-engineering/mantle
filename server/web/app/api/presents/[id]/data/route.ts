/**
 * /api/presents/[id]/data: a Present canvas's data store (DWG phase 7a;
 * @mantle/content/canvas-data has the rules, @mantle/content-core/canvas-data
 * the contract). The canvas never calls this: it runs sandboxed with no
 * network, and its host page (share-ui CanvasSandbox) forwards its
 * `mantle.data` calls here as the signed-in user, for this canvas only.
 *
 *  GET    ?info=1                         what the reader may do
 *  GET    ?bucket=&key=                   one entry ({ entry } or null)
 *  GET    ?bucket=[&everyone=1]           the bucket's entries ({ entries })
 *  PUT    { bucket, key, value }          save one entry
 *  DELETE ?bucket=&key=[&by=]             remove one entry
 *  DELETE ?all=1                          clear the canvas's data
 *
 * `shared`: every reader reads, a write asks Write on the canvas. `mine`:
 * the login's own entries; `everyone=1` lists every login's, Write only.
 * Moderation, Write only: `by=<login id>` removes another login's `mine`
 * entry, and `all=1` removes every entry of the canvas. The writes are the
 * store's definers (0336), in the login's own scope.
 * A write declares read, its lowest right; the shared bucket's edit runs
 * as its higher cells (a8-route-cells.ts).
 */
import { NextResponse } from '@/server/http-compat';
import { ownerLoginCaller } from '@/lib/auth';
import type { Login } from '@/lib/auth/login';
import {
  canvasDataInfo,
  clearCanvasData,
  deleteCanvasData,
  getCanvasData,
  listCanvasData,
  setCanvasData,
  type CanvasDataCaller,
  type CanvasDataRefusal,
} from '@mantle/content/canvas-data';
import { readJson } from '@/lib/read-body';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  GET: { class: 'content', open: 'owner', limits: { rateLimit: ['canvasData'] } },
  PUT: {
    class: 'content',
    open: 'owner',
    makesItems: false,
    item: { param: 'id', need: 'read' },
    limits: { rateLimit: ['canvasDataWrite'] },
  },
  DELETE: {
    class: 'content',
    open: 'owner',
    item: { param: 'id', need: 'read' },
    limits: { rateLimit: ['canvasDataWrite'] },
  },
});

/** The caller the store reads and writes for: the session's login, never
 *  anything the request names. */
function callerOf(login: Login): CanvasDataCaller {
  return { ownerId: login.brainId, loginId: login.loginId, name: login.displayName };
}

const STATUS: Record<CanvasDataRefusal['reason'], number> = {
  missing: 404,
  forbidden: 403,
  full: 413,
  invalid: 400,
};

function refused(r: CanvasDataRefusal): Response {
  return r.reason === 'missing'
    ? NextResponse.json({ error: 'not found' }, { status: 404 })
    : NextResponse.json({ error: r.error }, { status: STATUS[r.reason] });
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const login = ownerLoginCaller();
  const who = callerOf(login);
  const { id } = await ctx.params;
  const q = new URL(req.url).searchParams;
  if (q.get('info') === '1') {
    const r = await canvasDataInfo(who, id);
    return r.ok ? NextResponse.json({ info: r.info }) : refused(r);
  }
  const bucket = q.get('bucket');
  if (q.has('key')) {
    const r = await getCanvasData(who, id, bucket, q.get('key'));
    return r.ok ? NextResponse.json({ entry: r.entry }) : refused(r);
  }
  const r = await listCanvasData(who, id, bucket, { everyone: q.get('everyone') === '1' });
  return r.ok ? NextResponse.json({ entries: r.entries }) : refused(r);
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const login = ownerLoginCaller();
  const who = callerOf(login);
  const { id } = await ctx.params;
  // A value is at most 64 KB of JSON; the body around it a little more.
  const body = (await readJson(req, { maxBytes: 96 * 1024 })) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('value' in body)) {
    return NextResponse.json({ error: 'bucket, key and value are required' }, { status: 400 });
  }
  const r = await setCanvasData(who, id, body.bucket, body.key, body.value);
  return r.ok ? NextResponse.json({ ok: true, updatedAt: r.updatedAt }) : refused(r);
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const login = ownerLoginCaller();
  const who = callerOf(login);
  const { id } = await ctx.params;
  const q = new URL(req.url).searchParams;
  if (q.get('all') === '1') {
    if (q.has('bucket') || q.has('key') || q.has('by')) {
      return NextResponse.json({ error: 'all=1 takes no bucket, key or by' }, { status: 400 });
    }
    const r = await clearCanvasData(who, id);
    return r.ok ? NextResponse.json({ ok: true, removed: r.removed }) : refused(r);
  }
  const r = await deleteCanvasData(who, id, q.get('bucket'), q.get('key'), {
    ...(q.has('by') ? { by: q.get('by') } : {}),
  });
  return r.ok ? NextResponse.json({ ok: true, deleted: r.deleted }) : refused(r);
}
