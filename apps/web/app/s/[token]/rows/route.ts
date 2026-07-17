import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db, nodes, tables } from '@mantle/db';
import { queryRowsWindow, resolveStoragePath } from '@mantle/tabledb';
import { resolveActiveShareByToken } from '@/lib/shares';
import { resolveShareVisitor } from '@/lib/team-gate';
import { rateLimit, clientIp } from '@/lib/rate-limit';

/**
 * Row window for a SHARED table — the public counterpart of
 * /api/tables/[id]/rows, and deliberately narrower: PUBLISHED file only (a
 * draft is the owner's working copy and never crosses the share boundary), no
 * distinct-values endpoint, no draft switch, offset paging only. Authorization
 * = an active table share + (for team mode) a live team session; everything
 * else 404s uniformly so a URL never reveals that a token exists.
 */
export const dynamic = 'force-dynamic';

function notFound() {
  return NextResponse.json({ error: 'not found' }, { status: 404, headers: { 'cache-control': 'no-store' } });
}

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;

  const { ok, retryAfterSec } = rateLimit(`share-rows:${clientIp(req)}`, {
    max: 120,
    windowMs: 60_000,
  });
  if (!ok) {
    return NextResponse.json(
      { error: 'too many requests' },
      { status: 429, headers: { 'retry-after': String(retryAfterSec), 'cache-control': 'no-store' } },
    );
  }

  const share = await resolveActiveShareByToken(token);
  if (!share || share.nodeType !== 'table') return notFound();
  if (!(await resolveShareVisitor(req.headers.get('cookie'), share))) return notFound();

  const [row] = await db
    .select({ storagePath: tables.storagePath })
    .from(tables)
    .innerJoin(nodes, eq(nodes.id, tables.nodeId))
    .where(and(eq(tables.nodeId, share.nodeId), eq(nodes.ownerId, share.ownerId), eq(nodes.type, 'table')))
    .limit(1);
  // Legacy JSONB tables ship their whole doc in the share view — the presenter
  // never calls this route for them.
  if (!row?.storagePath) return notFound();

  const url = new URL(req.url);
  const tabId = url.searchParams.get('tab') ?? undefined;
  const limitRaw = Number(url.searchParams.get('limit') ?? '200');
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 500)) : 200;
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);

  try {
    const page = queryRowsWindow(resolveStoragePath(row.storagePath), {
      offset,
      limit,
      ...(tabId ? { tabId } : {}),
    });
    if (!page) return NextResponse.json({ error: 'window read failed' }, { status: 500 });
    return NextResponse.json(
      { rows: page.rows, total: page.total, offset },
      { headers: { 'cache-control': 'private, max-age=30' } },
    );
  } catch {
    // Unknown tab / missing file — uniform 404, never an error detail.
    return notFound();
  }
}
