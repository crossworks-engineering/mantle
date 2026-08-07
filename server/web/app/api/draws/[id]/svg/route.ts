import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { getDrawSvg } from '@/lib/draws';

/**
 * The committed SVG snapshot, as JSON (`{ svg }`) so apiFetch's bearer carries
 * it in the split deployment, where an image element's src cannot. The list
 * preview turns the string into a blob URL and renders it AS AN IMAGE; it is
 * never injected into the page as markup. `svg: null` when the last commit
 * carried no valid snapshot.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const svg = await getDrawSvg(user.id, id);
  return NextResponse.json({ svg });
}
