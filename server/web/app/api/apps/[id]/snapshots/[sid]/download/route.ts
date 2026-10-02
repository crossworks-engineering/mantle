/**
 * GET /api/apps/[id]/snapshots/[sid]/download — a snapshot's database copy
 * as a .sqlite file (opens in any SQLite tool). Streamed: a copy can be as
 * large as the app's database (APP_SQL_MAX_DB_MB). Owner only; 404 for an
 * entry with no data (a version).
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { getAppRuntime } from '@mantle/content';
import { appSnapshotFile } from '@mantle/content/app-snapshots';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string; sid: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id, sid } = await ctx.params;
  const [app, file] = await Promise.all([
    getAppRuntime(user.id, id),
    appSnapshotFile(user.id, id, sid),
  ]);
  if (!app || !file) return NextResponse.json({ error: 'not found' }, { status: 404 });
  let size: number;
  try {
    size = (await stat(file.path)).size;
  } catch {
    return NextResponse.json({ error: 'the snapshot file is missing' }, { status: 410 });
  }
  const base = app.title.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'app';
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
