import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { recordAppOpen } from '@mantle/content';
import { UUID_RE } from '@mantle/std';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

/** The ids are uuids: any other names nothing, the params gateway's one
 *  404 before the handler (lib/route-params.ts). */
export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  POST: {
    class: 'content',
    makesItems: false,
    item: { param: 'id', need: 'read' },
  },
});

/**
 * POST /api/apps/:id/opened — count one open of this app by the signed-in
 * login. Feeds the sidebar's "Most used" and "Recent" filters. Clients call it
 * fire-and-forget when an app is launched; it never blocks the open.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'app not found' }, { status: 404 });
  const ok = await recordAppOpen(user.id, user.actor.id, id.toLowerCase());
  if (!ok) return NextResponse.json({ error: 'app not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
