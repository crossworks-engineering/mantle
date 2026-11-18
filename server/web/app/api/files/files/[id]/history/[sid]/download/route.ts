/**
 * GET /api/files/files/[id]/history/[sid]/download: a kept version's bytes,
 * as a download under the file's name with its version (docs/files.md,
 * "File history"). Whoever reads the file, as its own bytes (the asset
 * reader: a session, or the `?at=` asset token of a download link), with
 * the member byte budget. Streamed. 410 when the bytes are gone.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { NextResponse } from '@/server/http-compat';
import { readerAssetCaller } from '@/lib/auth';
import { fileVersion } from '@mantle/files';
import { safeDownloadHeaders } from '@mantle/client-types/lib/safe-download';
import { CACHE_CONTROL } from '@/lib/cache-control';
import { historyFileOrNull } from '@/lib/file-history-route';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

/** The ids are uuids: any other names nothing, the one 404 before the
 *  handler (lib/route-params.ts). */
export const routeParams = { id: 'uuid', sid: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  GET: { class: 'content', open: 'owner', limits: { rateLimit: ['memberBytes'] } },
});

/** `report.pdf`, v3 -> `report (v3).pdf`. */
function versionName(filename: string, seq: number): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0
    ? `${filename.slice(0, dot)} (v${seq})${filename.slice(dot)}`
    : `${filename} (v${seq})`;
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string; sid: string }> }) {
  const { user } = readerAssetCaller();
  const { id, sid } = await ctx.params;
  const file = await historyFileOrNull(user.id, id);
  if (!file) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const v = await fileVersion(user.id, id, sid);
  if (!v) return NextResponse.json({ error: 'not found' }, { status: 404 });
  let size: number;
  try {
    if (!v.abs) throw new Error('no path');
    size = (await stat(v.abs)).size;
  } catch {
    return NextResponse.json({ error: 'the version is missing on the server' }, { status: 410 });
  }
  const web = Readable.toWeb(createReadStream(v.abs)) as unknown as NodeReadableStream<Uint8Array>;
  return new NextResponse(web as unknown as ReadableStream, {
    status: 200,
    headers: {
      ...safeDownloadHeaders(file.mimeType, versionName(v.filename ?? file.filename, v.seq)),
      'content-length': String(size),
      // Never kept by a shared cache or the browser.
      'cache-control': CACHE_CONTROL.privateNone,
    },
  });
}
