/**
 * One file on a task (files on tasks, plan page 74b70ac6).
 *
 *  - GET: the bytes (`?thumb=1`: an image's thumbnail). An `<img src>`, so
 *    it takes the `?at=` asset token (auth-constants isAssetPath). The one
 *    check is read of the task: who reads the task opens its files. The
 *    file must sit in the task's folder; any other id is a 404.
 *  - DELETE: take the file off the task (the file is deleted). The one
 *    check is edit of the task.
 */
import { NextResponse } from '@/server/http-compat';
import { ownerCaller, readerAssetCaller } from '@/lib/auth';
import { readTaskFile, removeTaskFile } from '@mantle/content';
import { thumbnailFor } from '@mantle/files';
import { safeDownloadHeaders } from '@mantle/client-types/lib/safe-download';
import { CACHE_CONTROL } from '@/lib/cache-control';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

export const routeParams = { id: 'uuid', fileId: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  GET: {
    class: 'content',
    open: 'owner',
    limits: { rateLimit: ['memberBytes', 'memberThumbs'] },
  },
  DELETE: {
    class: 'content',
    open: 'owner',
    item: { param: 'id', need: 'edit' },
  },
});

type Ctx = { params: Promise<{ id: string; fileId: string }> };
const NOT_FOUND = () => NextResponse.json({ error: 'not found' }, { status: 404 });

export async function GET(req: Request, ctx: Ctx) {
  const { user } = readerAssetCaller();
  const { id, fileId } = await ctx.params;
  const res = await readTaskFile(user.id, id, fileId);
  if (!res) return NOT_FOUND();
  if (new URL(req.url).searchParams.get('thumb') === '1') {
    const sha = res.row.sha256;
    if (!sha) return NextResponse.json({ error: 'no thumbnail' }, { status: 404 });
    const etag = `"${sha}.thumb"`;
    if (req.headers.get('if-none-match') === etag) {
      return new Response(null, {
        status: 304,
        headers: { etag, 'cache-control': CACHE_CONTROL.privateRevalidate },
      });
    }
    const thumb = await thumbnailFor({
      sha256: sha,
      mimeType: res.row.mimeType,
      loadBytes: async () => res.bytes,
    });
    if (!thumb) return NextResponse.json({ error: 'no thumbnail' }, { status: 404 });
    return new Response(new Uint8Array(thumb), {
      status: 200,
      headers: {
        'content-type': 'image/jpeg',
        'content-length': String(thumb.byteLength),
        'x-content-type-options': 'nosniff',
        etag,
        'cache-control': CACHE_CONTROL.privateRevalidate,
      },
    });
  }
  return new Response(new Uint8Array(res.bytes), {
    status: 200,
    headers: {
      ...safeDownloadHeaders(res.row.mimeType, res.row.filename),
      'content-length': String(res.bytes.byteLength),
      // Read in the login's scope: never stored.
      'cache-control': CACHE_CONTROL.privateNone,
    },
  });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const user = ownerCaller();
  const { id, fileId } = await ctx.params;
  const ok = await removeTaskFile(user.id, id, fileId);
  if (!ok) return NOT_FOUND();
  return NextResponse.json({ ok: true });
}
