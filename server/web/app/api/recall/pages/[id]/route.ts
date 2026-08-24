import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { getRecallStateForPage } from '@/lib/recall';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The editor lint badge: this page's place in Recall, or `state: null` —
 *  a 200 either way, so the editor can probe every open page cheaply. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ state: null });
  const state = await getRecallStateForPage(user.id, id);
  return NextResponse.json({ state });
}
