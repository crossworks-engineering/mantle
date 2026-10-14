import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import {
  assertMayLink,
  checkServeList,
  getContactShare,
  setContactShareCanWrite,
  TeamLinkRetiredError,
} from '@mantle/content';
import { applyShareMode, getLiveShare, revokeShare, SERVE_MAX, setShareServed } from '@/lib/shares';
import { requireArea, type WsCaller } from '@/lib/workspaces';
import { readJson } from '@/lib/read-body';

/** DELETE /api/shares/[id] → `{ ok }`: revoke the link or the contact share
 *  (owner-scoped; `ok` false when it was already gone). Who may: a user who
 *  may edit the item (an app: a Moderator of its home), the Grant Access
 *  panel's `mayLink`; or an Admin user with the 'users' area, who may revoke
 *  any link of the brain (W5b2 part B: closing a link only narrows); else
 *  404 `not_found` or 403 `forbidden`. A link never changes a level or a
 *  grant, so removing one changes none either (the item's share dialog
 *  Remove and the contact's "Shared" tab Revoke both call this). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await params;
  const share = await getLiveShare(user.id, id);
  if (!share) return NextResponse.json({ ok: false });
  try {
    await assertMayLink(user.id, user.actor.id, share.nodeId);
  } catch (err) {
    const caller: WsCaller = {
      kind: 'admin',
      loginId: user.actor.id,
      anchorId: user.id,
      user,
    };
    // A refusal answers by its row in the one table (LinkRefusedError).
    if (!(await requireArea(caller, 'users'))) throw err;
  }
  return NextResponse.json({ ok: await revokeShare(user.id, id) });
}

const PatchBody = z.union([
  z.object({ mode: z.string() }),
  z.object({ canWrite: z.boolean() }),
  z.object({ serve: z.array(z.string().uuid()).max(SERVE_MAX) }),
]);

/** PATCH /api/shares/[id] { serve } → `{ ok: true, served }`: replace an
 *  open link's served list (plan 8.1), with the checks of POST /api/shares:
 *  who may change the link (`mayLink`), and each id ADDED must be named or
 *  embedded by the item (a folder link: sit in the folder) and editable by
 *  the caller. 404 `not_found` (no such live open link, or an item or id
 *  the caller cannot read), 403 `forbidden`.
 *
 *  PATCH /api/shares/[id] { canWrite } → "Can write" on a contact share of
 *  an app (contact shares, 0214); 400 `write-not-app` on another kind.
 *  Audited (`contact.share_can_write`).
 *
 *  PATCH /api/shares/[id] { mode } → set the link's admission (owner-scoped).
 *  'public' is the only mode (a live link already is: this confirms it).
 *  'team' is refused with 400 `team-links-retired`: team links are retired
 *  (member logins Phase 6 stage 6), members use their own logins. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await params;
  const parsed = PatchBody.safeParse(await readJson(req));
  if (!parsed.success) return NextResponse.json({ error: 'invalid mode' }, { status: 400 });
  if ('serve' in parsed.data) {
    const share = await getLiveShare(user.id, id);
    if (!share || share.contactId) {
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
  // { canWrite }: a live contact share of an app (contact shares, 0214).
  if ('canWrite' in parsed.data) {
    const share = await getContactShare(user.id, id);
    if (!share) return NextResponse.json({ error: 'not found' }, { status: 404 });
    if (share.nodeType !== 'app') {
      return NextResponse.json(
        { error: 'Only an app can let a contact write.', reason: 'write-not-app' },
        { status: 400 },
      );
    }
    const ok = await setContactShareCanWrite(user.id, id, parsed.data.canWrite);
    if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
    auditFireAndForget({
      actorId: user.actor.id,
      actorEmail: user.actor.email,
      action: 'contact.share_can_write',
      method: 'PATCH',
      path: '/api/shares/:id',
      detail: { shareId: id, contactId: share.contactId, value: parsed.data.canWrite },
      ...requestMetaFrom(req),
    });
    return NextResponse.json({ ok: true, canWrite: parsed.data.canWrite });
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
