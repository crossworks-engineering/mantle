/**
 * POST /s/[token]/tool-broker: a SHARED app's host.tools.call().
 *
 * An OPEN link (no contact) gets NO tools, ever: anyone with the URL is the
 * caller, and every brain read tool reaches the owner's content by content,
 * with no per-node "public" flag to scope against.
 *
 * A CONTACT share (migration 0214), past the contact's code gate, may call
 * ONE kind of tool: an outside tool (mcp or http) an admin switched
 * "External access" on for, that the app declares (contactAppToolVerdict,
 * packages/tools/src/external-access.ts). Never a
 * built-in. The contact may send any input, by hand too, not only what the
 * app's screens send: the admin confirmed the tool only reads. The call runs
 * on the public role, on a contact surface that names the contact and the
 * share, and is logged with the contact in the app's Activity and the
 * share's trail, refused calls included, and its errors in the app's
 * error log. A config of the one app tool broker (lib/app-tool-broker.ts
 * runAppToolBroker): this route answers the link's own refusals
 * (the code gate, a share that is not an app's, an open link), the broker
 * the rest.
 *
 * Members and clients run apps from their own logins
 * (/api/member/apps/:id/tool-broker, /api/client/apps/:id/tool-broker).
 */
import { contactCodeRequired, gateShare } from '@/lib/contact-share-gate';
import { NextResponse } from '@/server/http-compat';
import { liveServedIds } from '@/lib/shares';
import { runAppToolBroker } from '@/lib/app-tool-broker';
import { getAppRuntime } from '@mantle/content';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'link',
    item: { none: 'a link route: its share token names what it opens' },
    limits: { rateLimit: ['shareToolBroker'] },
  },
});

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;

  // The gate took the row's per-address limit (lib/route-limits.ts shareToolBroker).

  const gate = await gateShare(req, token);
  if (gate.kind === 'code') return contactCodeRequired(gate.share);
  const share = gate.kind === 'ok' ? gate.share : null;
  if (!share || share.nodeType !== 'app') {
    return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  }
  const contactId = share.contactId ?? null;
  if (!contactId) {
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

  return runAppToolBroker(req, {
    via: 'contact',
    ownerId: share.ownerId,
    share: { id: share.id, contactId },
    // The published build only: a link never runs the draft.
    app: async () => {
      const app = await getAppRuntime(share.ownerId, share.nodeId);
      return app?.publishedBuild?.ok ? app : null;
    },
    served: async () => [...(await liveServedIds(share))],
  });
}
