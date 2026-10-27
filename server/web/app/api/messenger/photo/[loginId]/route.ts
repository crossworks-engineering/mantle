import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { getContent } from '@mantle/storage';
import { anyLoginCaller } from '@/lib/auth';
import { CACHE_CONTROL } from '@/lib/cache-control';
import { messengerActorOf, messengerLoginPhoto } from '@/lib/messenger';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'self', scope: null, open: 'any', limits: { rateLimit: ['messengerRead'] } },
});

/**
 * GET /api/messenger/photo/:loginId?v=<photoVersion>: another login's
 * uploaded profile photo, for the chat list, the header, the bubbles and
 * the New message pick list (`photoVersion` on a participant or a
 * directory entry). Served only when the caller may see that login:
 * itself, a login of its directory (a live workspace shared; every usable
 * login for an Admin user) or a person of a chat it is in, as it sees the
 * room (messengerLoginPhoto). Anything else, and a login with no photo,
 * is the one 404, never a 403: whether a login exists is not told.
 *
 * The headers are GET /api/profile/photo's: a raster type from the
 * projected allowlist, `nosniff`, a CSP that runs nothing, and `private`
 * caching, so no shared cache holds a face. `immutable` only when `v` names
 * the photo served (the key is content-addressed); any other `v` gets the
 * bytes revalidated on every use, so an old URL never pins a new photo.
 */
export async function GET(req: Request, ctx: { params: Promise<{ loginId: string }> }) {
  const login = anyLoginCaller();
  const { loginId } = await ctx.params;
  const notFound = () => new Response('Not found', { status: 404 });
  const photo = await messengerLoginPhoto(messengerActorOf(login), loginId);
  if (!photo) return notFound();
  const v = new URL(req.url).searchParams.get('v');
  try {
    const obj = await getContent(photo.key);
    const headers = new Headers({
      'content-type': photo.type,
      'Cache-Control':
        v === photo.version ? CACHE_CONTROL.privateImmutable : CACHE_CONTROL.privateRevalidate,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      'content-disposition': 'inline',
    });
    if (obj.contentLength) headers.set('content-length', String(obj.contentLength));
    const webStream = Readable.toWeb(obj.body) as unknown as NodeReadableStream<Uint8Array>;
    return new Response(webStream as unknown as ReadableStream, { headers });
  } catch {
    // Storage unreachable or the object gone: the client steps down to the
    // avatar. (A failed access read is the route's 500, as on every other
    // messenger route.)
    return notFound();
  }
}
