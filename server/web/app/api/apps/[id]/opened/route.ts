import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { recordAppOpen } from '@mantle/content';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/apps/:id/opened — count one open of this app by the signed-in
 * login. Feeds the sidebar's "Most used" and "Recent" filters. Clients call it
 * fire-and-forget when an app is launched; it never blocks the open.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'app not found' }, { status: 404 });
  const ok = await recordAppOpen(user.id, user.actor.id, id.toLowerCase());
  if (!ok) return NextResponse.json({ error: 'app not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
