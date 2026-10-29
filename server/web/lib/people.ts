/**
 * People's HTTP adapter (docs/messenger.md, "People"): the routes under
 * /api/people/* (and the messenger's older photo path) read the caller and
 * hand @mantle/content/people the authenticated login. Every rule is in
 * the content module; this file maps a request to it and serves a photo.
 */
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { getContent } from '@mantle/storage';
import type { PeopleCaller } from '@mantle/content/people';
import { personPhoto } from '@mantle/content/people';
import type { Login } from '@/lib/auth/login';
import { CACHE_CONTROL } from '@/lib/cache-control';

export {
  PEOPLE_PRESENCE_MAX,
  peoplePresence,
  personCards,
  personPhoto,
} from '@mantle/content/people';

/** The caller of a request: the authenticated login, in its brain. */
export function peopleCallerOf(login: Login): PeopleCaller {
  return { ownerId: login.brainId, loginId: login.loginId };
}

/**
 * GET /api/people/:id/photo?v= (and its alias GET
 * /api/messenger/photo/:loginId): another login's uploaded profile photo,
 * served only when the caller may see that login (personPhoto, the people
 * gate). Anything else, and a login with no photo, is the one 404, never a
 * 403: whether a login exists is not told.
 *
 * The headers are GET /api/profile/photo's: a raster type from the
 * projected allowlist, `nosniff`, a CSP that runs nothing, and `private`
 * caching, so no shared cache holds a face. `immutable` only when `v` names
 * the photo served (the key is content-addressed); any other `v` gets the
 * bytes revalidated on every use, so an old URL never pins a new photo.
 */
export async function servePersonPhoto(
  req: Request,
  login: Login,
  loginId: string,
): Promise<Response> {
  const notFound = () => new Response('Not found', { status: 404 });
  const photo = await personPhoto(peopleCallerOf(login), loginId);
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
    // people route.)
    return notFound();
  }
}
