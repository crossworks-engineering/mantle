import { z } from 'zod';
import { withViewer } from '@mantle/db';
import { clientDrawSvg, getDrawSvg } from '@mantle/content';
import { getClientForAsset } from '@/lib/auth';
import { clientBytesGate } from '@/lib/client-bytes';

const IdParams = z.object({ id: z.string().uuid() });

/**
 * GET /api/client/draws/:id/svg : a drawing's committed SVG snapshot for a
 * CLIENT, as an image (client logins, Phase C2). Never the scene or the
 * draft. Read at the client level only: a drawing above it is a 404. No
 * render fallback: a drawing with no snapshot yet shows as missing until it
 * is saved.
 *
 * The snapshot inlines its images' bytes, so it is sent with only the images
 * whose file is a client-level file (the client files route's rule). A team
 * or admin image in a client drawing is taken out and its frame shows empty,
 * and an element link to an item the client may not read loses its href.
 * Rate limited per login like the files route (audit B25), before any read.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const client = await getClientForAsset(req);
  if (client instanceof Response) return client;
  const limited = clientBytesGate(req, client);
  if (limited) return limited;
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return new Response('Invalid id', { status: 400 });
  const id = idParsed.data.id;
  const out = await withViewer('client', async () => {
    const svg = await getDrawSvg(client.anchorId, id);
    return svg ? clientDrawSvg(client.anchorId, id, svg) : null;
  });
  if (!out) {
    return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  }
  return new Response(out, {
    status: 200,
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=300',
    },
  });
}
