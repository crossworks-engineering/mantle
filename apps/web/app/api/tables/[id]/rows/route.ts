import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db, nodes, tables } from '@mantle/db';
import { distinctColumnValues, draftPathFor, listRowsWindow, queryRowsWindow, resolveStoragePath } from '@mantle/tabledb';
import { existsSync } from 'node:fs';
import { getOwnerOr401 } from '@/lib/auth';

/**
 * Keyset page of rows for the grid's lazy-load (P3). Draft-first like every
 * other read surface: ?draft=1 reads the draft file when one exists (falls
 * back to published when not). Cursor = the last row of the previous page
 * (after_pos + after_rid); omit for the first page.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const [row] = await db
    .select({ storagePath: tables.storagePath })
    .from(tables)
    .innerJoin(nodes, eq(nodes.id, tables.nodeId))
    .where(and(eq(tables.nodeId, id), eq(nodes.ownerId, user.id), eq(nodes.type, 'table')))
    .limit(1);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!row.storagePath) {
    // Legacy JSONB table — the whole doc already ships in GET /api/tables/[id].
    return NextResponse.json({ error: 'table has no windowed storage; use the full document' }, { status: 400 });
  }
  const url = new URL(req.url);
  const wantDraft = url.searchParams.get('draft') === '1';
  const afterPos = url.searchParams.get('after_pos');
  const afterRid = url.searchParams.get('after_rid');
  const limitRaw = Number(url.searchParams.get('limit') ?? '500');
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 1000)) : 500;

  const offsetParam = url.searchParams.get('offset');
  const tabId = url.searchParams.get('tab') ?? undefined;

  const publishedAbs = resolveStoragePath(row.storagePath);
  const draftAbs = draftPathFor(publishedAbs);
  const file = wantDraft && existsSync(draftAbs) ? draftAbs : publishedAbs;
  try {
    // Distinct values of one column — the option list a reference column's
    // editor offers (?distinct=<columnId>, optional ?prefix= typeahead).
    const distinct = url.searchParams.get('distinct');
    if (distinct) {
      const values = distinctColumnValues(file, {
        columnId: distinct,
        ...(tabId ? { tabId } : {}),
        ...(url.searchParams.get('prefix') ? { prefix: url.searchParams.get('prefix')! } : {}),
        limit,
      });
      return NextResponse.json({ values, source: file === draftAbs ? 'draft' : 'published' });
    }
    // Offset paging (the grid's "load more" appends from a known position);
    // keyset (`after_pos`/`after_rid`) stays the cheaper cursor for crawls.
    if (offsetParam !== null) {
      const offset = Math.max(0, Number(offsetParam) || 0);
      const page = queryRowsWindow(file, { offset, limit, ...(tabId ? { tabId } : {}) });
      if (!page) return NextResponse.json({ error: 'window read failed' }, { status: 500 });
      return NextResponse.json({
        rows: page.rows,
        total: page.total,
        offset,
        source: file === draftAbs ? 'draft' : 'published',
      });
    }
    const page = listRowsWindow(file, {
      limit,
      ...(tabId ? { tabId } : {}),
      ...(afterPos !== null && afterRid !== null ? { after: { pos: Number(afterPos), rid: afterRid } } : {}),
    });
    return NextResponse.json({
      rows: page.rows,
      total: page.total,
      cursor: page.cursor,
      source: file === draftAbs ? 'draft' : 'published',
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'window read failed' }, { status: 500 });
  }
}
