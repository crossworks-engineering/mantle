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
 * packages/tools/src/external-access.ts; decided 2026-10-02). Never a
 * built-in. The contact may send any input, by hand too, not only what the
 * app's screens send: the admin confirmed the tool only reads. The call runs
 * on the public role, on a contact surface that names the contact and the
 * share, and is logged with the contact in the app's Activity and the
 * share's trail, refused calls included.
 *
 * Members and clients run apps from their own logins
 * (/api/member/apps/:id/tool-broker, /api/client/apps/:id/tool-broker).
 */
import { z } from 'zod';
import { contactCodeRequired, gateShare } from '@/lib/contact-share-gate';
import { NextResponse } from '@/server/http-compat';
import { clientIpKey, rateLimit } from '@/lib/rate-limit';
import { SHARE_BODY_CEILING_BYTES, readJsonCapped } from '@/lib/body-limit';
import { withViewer } from '@mantle/db';
import { getAppRuntime, recordAppAccess, recordShareAccess } from '@mantle/content';
import { contactAppToolVerdict, dispatchTool, outsideCallLogDetail } from '@mantle/tools';

const Body = z.object({
  slug: z.string().min(1).max(120),
  input: z.record(z.string(), z.unknown()).optional().default({}),
});

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;

  const { ok, retryAfterSec } = rateLimit(`share-tool-broker:${clientIpKey(req)}`, {
    max: 60,
    windowMs: 60_000,
  });
  if (!ok) {
    return NextResponse.json(
      { ok: false, error: 'too many requests' },
      { status: 429, headers: { 'retry-after': String(retryAfterSec) } },
    );
  }

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

  const parsed = Body.safeParse((await readJsonCapped(req, SHARE_BODY_CEILING_BYTES)) ?? {});
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'invalid input' }, { status: 400 });
  }
  const app = await getAppRuntime(share.ownerId, share.nodeId);
  if (!app || !app.publishedBuild?.ok) {
    return NextResponse.json({ ok: false, error: 'app not found' }, { status: 404 });
  }

  const { slug, input } = parsed.data;
  const verdict = await contactAppToolVerdict(share.ownerId, app.manifest.toolSlugs ?? [], slug);
  recordAppAccess({
    ownerId: share.ownerId,
    appNodeId: share.nodeId,
    shareId: share.id,
    contactId,
    kind: 'tool',
    detail: verdict.ok
      ? { via: 'contact', contactId, slug, ...outsideCallLogDetail(verdict, input) }
      : { via: 'contact', contactId, slug, refused: verdict.reason },
  });
  recordShareAccess({
    ownerId: share.ownerId,
    shareId: share.id,
    contactId,
    kind: verdict.ok ? 'tool' : 'refused',
    detail: verdict.ok ? { slug } : { slug, refused: 'tools' },
  });
  if (!verdict.ok) {
    return NextResponse.json({ ok: false, error: verdict.reason }, { status: verdict.status });
  }
  const result = await withViewer('public', () =>
    dispatchTool(verdict.tool, input, {
      ownerId: share.ownerId,
      surface: { kind: 'contact', contactId, shareId: share.id },
    }),
  );
  return NextResponse.json(result);
}
