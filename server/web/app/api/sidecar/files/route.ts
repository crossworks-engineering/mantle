/**
 * The Sync service's files (Sync service plan M3; lib/sidecar-files.ts):
 *
 *   GET  /api/sidecar/files?source=&after=  one page of a drive's file map
 *   POST /api/sidecar/files?source=&item=&path=&name=[&mime&hash&size&mod]
 *        one file's bytes as the raw body (rclone cat, streamed): spooled to
 *        disk with its sha256, then an ordinary file node (one per owner
 *        and sha256), its map row, and the node it replaced retired. Its
 *        body ceiling is BUFFERED_UPLOAD_BYTES (lib/body-limit.ts): a larger
 *        file answers 413 and the sidecar skips it.
 */
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { NextResponse } from '@/server/http-compat';
import { listSyncItems } from '@mantle/db';
import { discardSpooled, MAX_UPLOAD_BYTES, spoolUpload, UploadTooLargeError } from '@mantle/files';
import { routePolicy } from '@/lib/auth/route-declaration';
import { FileQuery } from '@/lib/sidecar-schemas';
import { asSidecar, sidecarOwner, sidecarRequestRefusal } from '@/lib/sidecar';
import { FILE_PATH_RE, FILE_SERVICE, storeSyncedFile } from '@/lib/sidecar-files';

export const policy = routePolicy({
  // No rate limit, as the gateway's routes (gateway/registry/route.ts says
  // why): the token is checked first and a refusal does no work.
  GET: { class: 'public' },
  POST: {
    class: 'public',
    item: { none: "a public route: it judges its own credential (the Sync sidecar's token)" },
  },
});

const AFTER_MAX = 400;

export async function GET(req: Request) {
  const refused = sidecarRequestRefusal(req);
  if (refused) return refused;
  const q = new URL(req.url).searchParams;
  const source = q.get('source') ?? '';
  const after = q.get('after');
  if (!source || source.length > 200 || (after !== null && after.length > AFTER_MAX)) {
    return NextResponse.json({ error: 'bad query' }, { status: 400 });
  }
  const items = await asSidecar(() => listSyncItems(FILE_SERVICE, source, after));
  return NextResponse.json({ items });
}

export async function POST(req: Request) {
  const refused = sidecarRequestRefusal(req);
  if (refused) return refused;
  const parsed = FileQuery.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success || !FILE_PATH_RE.test(parsed.data.path) || !req.body) {
    return NextResponse.json({ error: 'bad request' }, { status: 400 });
  }
  const q = parsed.data;
  let spooled;
  try {
    spooled = await spoolUpload(
      Readable.fromWeb(req.body as unknown as NodeReadableStream<Uint8Array>),
      { maxBytes: MAX_UPLOAD_BYTES },
    );
  } catch (err) {
    if (err instanceof UploadTooLargeError) {
      return NextResponse.json({ error: 'file too large' }, { status: 413 });
    }
    throw err;
  }
  try {
    // The listing's size and the bytes that came must agree: a stream cut
    // short (rclone stopped mid-file) is never stored.
    if (q.size !== undefined && spooled.size !== q.size) {
      return NextResponse.json({ error: 'the file arrived cut short' }, { status: 400 });
    }
    const stored = await asSidecar(async () =>
      storeSyncedFile(
        await sidecarOwner(),
        {
          source: q.source,
          itemId: q.item,
          path: q.path,
          name: q.name,
          mimeType: q.mime,
          hash: q.hash ?? null,
          size: q.size ?? null,
          modTime: q.mod ?? null,
        },
        spooled,
      ),
    );
    return NextResponse.json(stored);
  } finally {
    await discardSpooled(spooled);
  }
}
