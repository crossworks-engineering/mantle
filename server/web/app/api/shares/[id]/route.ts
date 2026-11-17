import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { UUID_RE } from '@mantle/std';
import { ownerCaller } from '@/lib/auth';
import {
  adminCloseShare,
  assertMayLink,
  checkServeList,
  TeamLinkRetiredError,
} from '@mantle/content';
import { applyShareMode, getLiveShare, revokeShare, SERVE_MAX, setShareServed } from '@/lib/shares';
import { readJson } from '@/lib/read-body';
import { itemNotFound, shareItemRefusal } from '@/lib/auth/item-answers';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  PATCH: {
    class: 'content',
    open: 'owner',
    item: {
      none: "a link, not an item: shareItemRefusal asks the right of the link's item in the login's scope",
    },
  },
  DELETE: {
    class: 'content',
    open: 'owner',
    item: {
      none: "a link, not an item: shareItemRefusal asks the right of the link's item in the login's scope",
    },
  },
});

/** DELETE /api/shares/[id] → `{ ok }`: revoke the link (owner-scoped; `ok` false when it was already gone). Who may: an Admin
 *  user with the 'users' area, who may revoke any link of the brain
 *  (closing a link only narrows; mantle_share_close_admin); else a user who may edit the item (an app or a
 *  Present canvas: a Moderator of its home, linkNeedsModerator), the Grant Access panel's `mayLink`, asked in the login's
 *  scope; else 404 `not found` or 403 `forbidden`, the item gate's answers.
 *  A link never changes a level or a grant, so removing one changes none
 *  either (the item's share dialog Remove calls this). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await params;
  if (!UUID_RE.test(id)) return itemNotFound();
  const byArea = await adminCloseShare(user.actor.id, id);
  if (byArea !== 'no-area') return NextResponse.json({ ok: byArea === 'closed' });
  const refused = await shareItemRefusal(id);
  if (refused) return refused;
  const share = await getLiveShare(user.id, id);
  if (!share) return NextResponse.json({ ok: false });
  // A refusal answers by its row in the one table (LinkRefusedError).
  await assertMayLink(user.id, user.actor.id, share.nodeId);
  return NextResponse.json({ ok: await revokeShare(user.id, id) });
}

const PatchBody = z.union([
  z.object({ mode: z.string() }),
  z.object({ serve: z.array(z.string().uuid()).max(SERVE_MAX) }),
]);

/** PATCH /api/shares/[id] { serve } → `{ ok: true, served }`: replace an
 *  open link's served list (plan 8.1), with the checks of POST /api/shares:
 *  who may change the link (`mayLink`), and each id ADDED must be named or
 *  embedded by the item (a folder link: sit in the folder) and editable by
 *  the caller. 404 `not_found` (no such live open link, or an item or id
 *  the caller cannot read), 403 `forbidden`.
 *
 *  PATCH /api/shares/[id] { mode } → set the link's admission (owner-scoped).
 *  'public' is the only mode (a live link already is: this confirms it).
 *  'team' is refused with 400 `team-links-retired`: team links are retired,
 *  members use their own logins.
 *
 *  Every change is the link's: asked first in the login's scope (shareItemRefusal), the item gate's 404 and 403. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await params;
  if (!UUID_RE.test(id)) return itemNotFound();
  const parsed = PatchBody.safeParse(await readJson(req));
  const refused = await shareItemRefusal(id);
  if (refused) return refused;
  if (!parsed.success) return NextResponse.json({ error: 'invalid mode' }, { status: 400 });
  if ('serve' in parsed.data) {
    const share = await getLiveShare(user.id, id);
    if (!share) {
      return NextResponse.json({ error: 'Link not found.', code: 'not_found' }, { status: 404 });
    }
    const item = await assertMayLink(user.id, user.actor.id, share.nodeId);
    const list = await checkServeList(
      user.id,
      user.actor.id,
      item,
      parsed.data.serve,
      share.served,
    );
    const updated = await setShareServed(user.id, id, list);
    if (!updated) {
      return NextResponse.json({ error: 'Link not found.', code: 'not_found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, served: updated.served });
  }
  const { mode } = parsed.data;
  if (mode === 'team') {
    const err = new TeamLinkRetiredError();
    return NextResponse.json({ error: err.message, reason: err.reason }, { status: 400 });
  }
  if (mode !== 'public') return NextResponse.json({ error: 'invalid mode' }, { status: 400 });
  const ok = await applyShareMode(user.id, id, mode);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
