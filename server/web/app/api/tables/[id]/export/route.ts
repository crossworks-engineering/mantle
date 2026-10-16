import { NextResponse } from '@/server/http-compat';
import { and, eq } from 'drizzle-orm';
import { db, nodes, tables } from '@mantle/db';
import { resolveStoragePath, snapshotFile } from '@mantle/tabledb';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ownerCaller } from '@/lib/auth';
import type { RouteParams } from '@/lib/route-params';

/** The [id] is a uuid: any other names nothing, the one 404 before the
 *  handler (lib/route-params.ts). */
export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

/**
 * Raw .sqlite download (P3) — the workbook file IS the interchange format.
 * The response is a VACUUM INTO snapshot (consistent under concurrent
 * writes), not the live file. Committed data only; drafts are not exported.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  const [row] = await db
    .select({ storagePath: tables.storagePath, title: nodes.title })
    .from(tables)
    .innerJoin(nodes, eq(nodes.id, tables.nodeId))
    .where(and(eq(tables.nodeId, id), eq(nodes.ownerId, user.id), eq(nodes.type, 'table')))
    .limit(1);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!row.storagePath) {
    return NextResponse.json(
      { error: 'table has no sqlite storage yet — commit it once to convert, then export' },
      { status: 400 },
    );
  }
  const snap = path.join(tmpdir(), `table-export-${randomUUID()}.sqlite`);
  try {
    snapshotFile(resolveStoragePath(row.storagePath), snap);
    const bytes = await readFile(snap);
    const filename = `${row.title.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'table'}.sqlite`;
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        'content-type': 'application/vnd.sqlite3',
        'content-disposition': `attachment; filename="${filename}"`,
      },
    });
  } finally {
    // A failed snapshot is a fault: the opaque 500, logged (A10 part 2).
    await rm(snap, { force: true }).catch(() => {});
  }
}
