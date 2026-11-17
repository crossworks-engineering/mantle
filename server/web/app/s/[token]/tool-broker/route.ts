/**
 * POST /s/[token]/tool-broker: a SHARED app's host.tools.call().
 *
 * An open link gets NO tools, ever: anyone with the URL is the caller, and
 * every brain read tool reaches the owner's content by content, with no
 * per-node "public" flag to scope against. The route stays so a shared
 * app's call gets a clear answer (the share-ui app sandbox calls it), not a
 * bare 404. (Contact shares, which could call an outside tool with External
 * access, are gone since migration 0378.)
 *
 * Members and clients run apps from their own logins
 * (/api/member/apps/:id/tool-broker, /api/client/apps/:id/tool-broker).
 */
import { openShareLink } from '@/lib/share-gate';
import { NextResponse } from '@/server/http-compat';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'link',
    item: { none: 'a link route: its share token names what it opens' },
    limits: { rateLimit: ['shareToolBroker'] },
  },
});

export async function POST(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;

  // The gate took the row's per-address limit (lib/route-limits.ts shareToolBroker).

  const share = await openShareLink(token);
  if (!share || share.nodeType !== 'app') {
    return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  }
  return NextResponse.json(
    {
      ok: false,
      error:
        'This is an open link, which can only use the app’s own data. ' +
        'Members and clients use the app’s tools from their own login.',
    },
    { status: 403 },
  );
}
