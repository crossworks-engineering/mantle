import { NextResponse } from '@/server/http-compat';
import { and, eq } from 'drizzle-orm';
import { db, nodes, tables } from '@mantle/db';
import { aggregateWindow, resolveStoragePath } from '@mantle/tabledb';
import { AGGREGATE_KINDS, type AggregateKind } from '@mantle/content';
import { resolveActiveShareByToken } from '@/lib/shares';
import { resolveShareVisitorFromRequest } from '@/lib/team-gate';
import { rateLimit, clientIp } from '@/lib/rate-limit';

/**
 * One footer total for a SHARED table, computed over the whole tab.
 *
 * The share view already carries the OWNER's totals with their values. This
 * route exists for the other half of the ask: a member picking sum/avg/count on
 * a column the owner set nothing on. That total is view-local and never
 * persisted — nothing here writes, and the shared surface stays read-only.
 *
 * ⚠ It has to be a round trip, and that is not an oversight. A file-backed
 * workbook pages 200 rows at a time, so a total computed from the rows a reader
 * happens to be holding is not an approximation — it is a different number, and
 * it looks exactly as authoritative as a right one. `aggregateWindow` runs the
 * aggregate in SQL across every row.
 *
 * Legacy JSONB tables never reach here: their whole doc ships in the share
 * view, so the reader computes locally with `computeAggregate`.
 *
 * Authorization is the rows route's, verbatim — an active table share plus (in
 * team mode) a live team session, and a uniform 404 for everything else so a
 * URL never reveals that a token exists.
 */

function notFound() {
  return NextResponse.json(
    { error: 'not found' },
    { status: 404, headers: { 'cache-control': 'no-store' } },
  );
}

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;

  const { ok, retryAfterSec } = rateLimit(`share-aggregate:${clientIp(req)}`, {
    max: 120,
    windowMs: 60_000,
  });
  if (!ok) {
    return NextResponse.json(
      { error: 'too many requests' },
      {
        status: 429,
        headers: { 'retry-after': String(retryAfterSec), 'cache-control': 'no-store' },
      },
    );
  }

  const share = await resolveActiveShareByToken(token);
  if (!share || share.nodeType !== 'table') return notFound();
  if (!(await resolveShareVisitorFromRequest(req, share))) return notFound();

  const url = new URL(req.url);
  const columnId = url.searchParams.get('col');
  const kindRaw = url.searchParams.get('kind') ?? '';
  const tabId = url.searchParams.get('tab') ?? undefined;
  // Validated against the vocabulary rather than cast: `kind` reaches a SQL
  // expression builder, and the only safe input is one of a known set.
  if (!columnId || !(AGGREGATE_KINDS as readonly string[]).includes(kindRaw)) return notFound();
  const kind = kindRaw as AggregateKind;

  const [row] = await db
    .select({ storagePath: tables.storagePath })
    .from(tables)
    .innerJoin(nodes, eq(nodes.id, tables.nodeId))
    .where(
      and(
        eq(tables.nodeId, share.nodeId),
        eq(nodes.ownerId, share.ownerId),
        eq(nodes.type, 'table'),
      ),
    )
    .limit(1);
  if (!row?.storagePath) return notFound();

  try {
    const value = aggregateWindow(resolveStoragePath(row.storagePath), {
      columnId,
      kind,
      ...(tabId ? { tabId } : {}),
    });
    // `null` is a real answer — "this column cannot be totalled that way" (a
    // formula target, or a sum over text). The reader draws a blank cell for
    // it, which is the honest rendering; a 0 would be a lie.
    return NextResponse.json({ value }, { headers: { 'cache-control': 'private, max-age=30' } });
  } catch {
    return notFound();
  }
}
