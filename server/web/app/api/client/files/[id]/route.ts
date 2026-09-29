import { NextResponse } from '@/server/http-compat';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { z } from 'zod';
import { withViewer } from '@mantle/db';
import { thumbnailFor } from '@mantle/files';
import { safeDownloadHeaders } from '@mantle/client-types/lib/safe-download';
import { acceptedFileMeta } from '@mantle/content';
import { getClientForAsset } from '@/lib/auth';
import { clientBytesGate } from '@/lib/client-bytes';
import { fileById, openFileById, readFileById } from '@/lib/files';

const IdParams = z.object({ id: z.string().uuid() });

/**
 * GET /api/client/files/:id : a file's bytes for a CLIENT (client logins,
 * Phase C2). `?thumb=1` = a JPEG thumbnail. Auth: a client session or a
 * client `?at=` token (an <img> src cannot carry a bearer). Every lookup runs
 * at the client level, so a file above it is a 404, with one exception
 * (client logins C5, the member rule of plan 6.2): a file this client wrote
 * and an admin accepted is read from the brain whatever its level (Accept
 * of a client's item defaults to team), but only while the brain file holds
 * exactly the bytes accepted; once an admin changed it, it is a 404 here and
 * /api/client/accepted/:id says `changedByAdmin`. Such a file is served
 * under the name and type it was accepted with (audit L7), never the brain
 * file's current name (an admin's rename). The bytes are streamed, and the
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
  // Client level first; the author's accepted file (any level) second, on
  // the admin pool, only after member-accepted.ts proved the author rule.
  // `accepted` is then the name and type it was accepted with.
  type Accepted = Awaited<ReturnType<typeof acceptedFileMeta>>;
  const lookup = async <T>(
    fn: () => Promise<T | null>,
  ): Promise<{ value: T; accepted: Accepted } | null> => {
    const atClient = await withViewer('client', fn);
    if (atClient) return { value: atClient, accepted: null };
    const accepted = await acceptedFileMeta(client.anchorId, client.loginId, scope.fileId);
    const value = accepted ? await fn() : null;
    return value ? { value, accepted } : null;
  };

  if (new URL(req.url).searchParams.get('thumb') === '1') {
    const meta = (await lookup(() => fileById(scope)))?.value;
    if (!meta?.sha256) return NextResponse.json({ error: 'not found' }, { status: 404 });
    const etag = `"${meta.sha256}.thumb"`;
    if (req.headers.get('if-none-match') === etag) {
      return new Response(null, { status: 304, headers: { etag } });
    }
    const thumb = await thumbnailFor({
      sha256: meta.sha256,
      mimeType: meta.mimeType,
      loadBytes: async () => {
        const res = (await lookup(() => readFileById(scope)))?.value;
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

  const found = await lookup(() => openFileById(scope));
  if (!found) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const { value: opened, accepted } = found;
  const web = Readable.toWeb(opened.stream) as unknown as NodeReadableStream<Uint8Array>;
  return new NextResponse(web as unknown as ReadableStream, {
    status: 200,
    headers: {
      ...safeDownloadHeaders(
        accepted ? (accepted.mimeType ?? opened.row.mimeType) : opened.row.mimeType,
        accepted ? accepted.filename : opened.row.filename,
      ),
      'content-length': String(opened.size),
    },
  });
}
