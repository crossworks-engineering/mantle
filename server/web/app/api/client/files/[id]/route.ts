import { NextResponse } from '@/server/http-compat';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { z } from 'zod';
import { withViewer } from '@mantle/db';
import { thumbnailFor } from '@mantle/files';
import { safeDownloadHeaders } from '@mantle/client-types/lib/safe-download';
import { getClientForAsset } from '@/lib/auth';
import { clientBytesGate } from '@/lib/client-bytes';
import { fileById, openFileById, readFileById } from '@/lib/files';

const IdParams = z.object({ id: z.string().uuid() });

/**
 * GET /api/client/files/:id : a file's bytes for a CLIENT (client logins,
 * Phase C2). `?thumb=1` = a JPEG thumbnail. Auth: a client session or a
 * client `?at=` token (an <img> src cannot carry a bearer). Every lookup runs
 * at the client level, so a file above it is a 404, with no exception (a
 * client writes nothing into the brain). The bytes are streamed, and the
 * route is rate limited per login (429) like the member bytes routes.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const client = await getClientForAsset(req);
  if (client instanceof Response) return client;
  const limited = clientBytesGate(req, client);
  if (limited) return limited;
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const scope = { ownerId: client.anchorId, fileId: idParsed.data.id };
  const lookup = <T>(fn: () => Promise<T | null>): Promise<T | null> => withViewer('client', fn);

  if (new URL(req.url).searchParams.get('thumb') === '1') {
    const meta = await lookup(() => fileById(scope));
    if (!meta?.sha256) return NextResponse.json({ error: 'not found' }, { status: 404 });
    const etag = `"${meta.sha256}.thumb"`;
    if (req.headers.get('if-none-match') === etag) {
      return new Response(null, { status: 304, headers: { etag } });
    }
    const thumb = await thumbnailFor({
      sha256: meta.sha256,
      mimeType: meta.mimeType,
      loadBytes: async () => {
        const res = await lookup(() => readFileById(scope));
        return res ? res.bytes : null;
      },
    });
    if (!thumb) return NextResponse.json({ error: 'no thumbnail' }, { status: 404 });
    return new Response(new Uint8Array(thumb), {
      status: 200,
      headers: {
        'content-type': 'image/jpeg',
        'content-length': String(thumb.byteLength),
        etag,
        'cache-control': 'private, max-age=3600',
      },
    });
  }

  const opened = await lookup(() => openFileById(scope));
  if (!opened) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const web = Readable.toWeb(opened.stream) as unknown as NodeReadableStream<Uint8Array>;
  return new NextResponse(web as unknown as ReadableStream, {
    status: 200,
    headers: {
      ...safeDownloadHeaders(opened.row.mimeType, opened.row.filename),
      'content-length': String(opened.size),
    },
  });
}
