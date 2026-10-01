/**
 * POST /s/[token]/tool-broker — a SHARED app's host.tools.call(). A share link
 * has no identified visitor, so it gets NO brain tools, ever: every read tool
 * reaches the owner's private content by content (search_chunks returns raw
 * email/journal passages, search_nodes filters by 'email'/'contact', and so
 * on), and there is no per-node "public" flag to scope against, so a link
 * that could call any of them would be an exfiltration channel. A shared app
 * is confined to its own SQLite (query-only db-broker).
 *
 * The route stays so the app SDK gets a clear refusal, not a 404. Team links,
 * whose identified members could call the app's declared builtin tools, are
 * retired (member logins Phase 6 stage 6): a member runs the app from their
 * own login (/api/member/apps/:id/tool-broker), where the level rules decide
 * what it reads.
 */
import { contactCodeRequired, gateShare } from '@/lib/contact-share-gate';
import { NextResponse } from '@/server/http-compat';
import { rateLimit, clientIp } from '@/lib/rate-limit';
import { recordShareAccess } from '@mantle/content';

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;

  const { ok, retryAfterSec } = rateLimit(`share-tool-broker:${clientIp(req)}`, {
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
  if (share.contactId) {
    recordShareAccess({
      ownerId: share.ownerId,
      shareId: share.id,
      contactId: share.contactId,
      kind: 'refused',
      detail: { refused: 'tools' },
    });
  }

  return NextResponse.json(
    {
      ok: false,
      error:
        'This is a shared link, which can only use the app’s own data. ' +
        'Members use the app’s Mantle tools from their own login.',
    },
    { status: 403 },
  );
}
