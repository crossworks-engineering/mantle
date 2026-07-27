import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { resolveSingleOwnerId } from '@mantle/db';
import { loadProfilePreferences } from '@mantle/content';
import { getContent } from '@mantle/storage';

/**
 * GET /api/appearance/logo — the brand logo bytes, public like the rest of
 * /api/appearance (PUBLIC_PATHS prefix): the same branding any share link
 * already renders. `?variant=dark` serves the dark-mode variant; the default
 * is the base logo. 404 when the addressed variant is not set — the CLIENT
 * owns the dark→base fallback (it knows both versions from /api/shell), so
 * this route never silently substitutes one variant for the other under an
 * immutable cache header.
 *
 * The pointer comes ONLY through the projections (loadProfilePreferences →
 * projectLogoKey/projectLogoType), so a hand-edited row can neither reach an
 * arbitrary storage object nor emit an unlisted Content-Type.
 *
 * SVG defense-in-depth (uploads are already script-rejected): CSP pins every
 * capability off, so even a hostile SVG opened as a top-level document can't
 * run script or fetch; nosniff stops type games. Content is sha-addressed —
 * the key changes when the logo does — so `immutable` caching is safe with
 * the `?v=<sha8>` the clients append.
 */
export async function GET(req: Request) {
  const notFound = new Headers({ 'cache-control': 'no-store' });
  try {
    const ownerId = await resolveSingleOwnerId();
    if (!ownerId) return new Response('Not found', { status: 404, headers: notFound });
    const prefs = await loadProfilePreferences(ownerId);
    const dark = new URL(req.url).searchParams.get('variant') === 'dark';
    const key = dark ? prefs.logoDarkKey : prefs.logoKey;
    const type = dark ? prefs.logoDarkType : prefs.logoType;
    if (!key || !type) {
      return new Response('Not found', { status: 404, headers: notFound });
    }
    const obj = await getContent(key);
    const headers = new Headers({
      'content-type': type,
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      'content-disposition': 'inline',
    });
    if (obj.contentLength) headers.set('content-length', String(obj.contentLength));
    const webStream = Readable.toWeb(obj.body) as unknown as NodeReadableStream<Uint8Array>;
    return new Response(webStream as unknown as ReadableStream, { headers });
  } catch {
    // Storage unreachable / object gone — a brand asset must never 500 a page.
    return new Response('Not found', { status: 404, headers: notFound });
  }
}
