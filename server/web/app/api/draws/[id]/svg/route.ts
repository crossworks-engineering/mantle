import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { getDrawSvgOrRender } from '@/lib/draw-snapshot';

/**
 * The committed SVG snapshot, as JSON (`{ svg }`) so apiFetch's bearer carries
 * it in the split deployment, where an image element's src cannot. The list
 * preview turns the string into a blob URL and renders it AS AN IMAGE; it is
 * never injected into the page as markup.
 *
 * Owner-authed, so this is one of the surfaces allowed to FILL the snapshot
 * cache: a drawing whose snapshot is missing or stale is re-rendered by the
 * browser sidecar on first view. `svg: null` only when there is nothing to
 * render (empty scene) or the sidecar is unavailable and nothing is cached.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const svg = await getDrawSvgOrRender(user.id, id);
  return NextResponse.json({ svg });
}
