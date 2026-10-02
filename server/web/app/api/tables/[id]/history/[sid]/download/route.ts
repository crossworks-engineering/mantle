/**
 * GET /api/tables/[id]/history/[sid]/download — a history entry's workbook
 * as a .sqlite file (opens in any SQLite tool: one table per tab, plus the
 * workbook's own metadata). Streamed. Owner only; 404 when not there.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { tableSnapshotFile, tableTitle } from '@mantle/content/table-snapshots';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string; sid: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id, sid } = await ctx.params;
  const [title, file] = await Promise.all([
    tableTitle(user.id, id),
    tableSnapshotFile(user.id, id, sid),
  ]);
  if (title === null || !file) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const { size } = await stat(file.path);
  const base = title.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'table';
  const web = Readable.toWeb(
    createReadStream(file.path),
  ) as unknown as NodeReadableStream<Uint8Array>;
  return new NextResponse(web as unknown as ReadableStream, {
    status: 200,
    headers: {
      'content-type': 'application/vnd.sqlite3',
      'content-disposition': `attachment; filename="${base}-v${file.seq}.sqlite"`,
      'content-length': String(size),
      'cache-control': 'no-store',
    },
  });
}
