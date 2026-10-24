/**
 * GET /api/presents/[id]/poster: a canvas's snapshot, the picture its latest
 * look drew (the poster, section 7.4), for a page that embeds the canvas
 * (`![Title](present:<id>)`).
 *
 *   (default)  the PNG, for the page's <img>. A detached client loads it
 *              with the short-lived `?at=` asset token, as a drawing's
 *              snapshot: an image element carries no bearer.
 *   ?meta=1    JSON `{ title, rev, posterRev, current }`, over the bearer:
 *              what the page shows around the picture (a canvas with no
 *              poster yet, a newer version than the picture).
 *
 * Read in the caller's scope (readerAssetCaller: every login since W7e,
 * as a drawing's snapshot): a canvas the login does not read is a 404 in
 * both shapes, the answer of an id no row has, so a page never tells a
 * reader anything of a canvas it may not read. The picture is never
 * rendered here: a page view spends no sidecar time (the poster is drawn
 * when a canvas is saved with a look).
 */
import { NextResponse } from '@/server/http-compat';
import { readerAssetCaller } from '@/lib/auth';
import { getPresentEmbedFacts, getPresentPoster } from '@/lib/presents';
import { CACHE_CONTROL } from '@/lib/cache-control';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  GET: { class: 'content', open: 'owner' },
});

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const reader = readerAssetCaller();
  const { id } = await ctx.params;
  const url = new URL(req.url);
  if (url.searchParams.get('meta') === '1') {
    const facts = await getPresentEmbedFacts(reader.user.id, id);
    if (!facts) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json({ ...facts, current: facts.posterRev === facts.rev });
  }
  const poster = await getPresentPoster(reader.user.id, id);
  if (!poster) return new Response('Not found', { status: 404 });
  // The poster changes with a save: the browser keeps it, and asks again
  // each time with the poster's rev as its tag.
  const etag = `"${id}.${poster.posterRev}"`;
  const headers = {
    'content-type': 'image/png',
    'x-content-type-options': 'nosniff',
    etag,
    'Cache-Control': CACHE_CONTROL.privateRevalidate,
  };
  if (req.headers.get('if-none-match') === etag)
    return new Response(null, { status: 304, headers });
  return new Response(new Uint8Array(poster.png), { status: 200, headers });
}
