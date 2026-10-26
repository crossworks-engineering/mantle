import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { UUID_RE } from '@mantle/std';
import { ownerCaller } from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import {
  adminCloseShare,
  adminSetContactShareCanWrite,
  assertMayLink,
  checkServeList,
  getContactShare,
  setContactShareCanWrite,
  TeamLinkRetiredError,
} from '@mantle/content';
import { applyShareMode, getLiveShare, revokeShare, SERVE_MAX, setShareServed } from '@/lib/shares';
import { readJson } from '@/lib/read-body';
import { readBodyCapped } from '@/lib/body-limit';
import { itemNotFound, shareItemRefusal } from '@/lib/auth/item-answers';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  PATCH: {
    class: 'content',
    item: {
      none: "a link, not an item: shareItemRefusal asks the right of the link's item in the login's scope",
    },
  },
  DELETE: {
    class: 'content',
    item: {
      none: "a link, not an item: shareItemRefusal asks the right of the link's item in the login's scope",
    },
  },
});

/** DELETE /api/shares/[id] → `{ ok }`: revoke the link or the contact share
 *  (owner-scoped; `ok` false when it was already gone). Who may: an Admin
 *  user with the 'users' area, who may revoke any link of the brain (W5b2
 *  part B: closing a link only narrows; mantle_share_close_admin, plan
 *  v3.2 S6 c2); else a user who may edit the item (an app: a Moderator of
 *  its home), the Grant Access panel's `mayLink`, asked in the login's
 *  scope; else 404 `not found` or 403 `forbidden`, the item gate's answers.
 *  A link never changes a level or a grant, so removing one changes none
 *  either (the item's share dialog Remove and the contact's "Shared" tab
 *  Revoke both call this). */
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
  z.object({ canWrite: z.boolean() }),
  z.object({ serve: z.array(z.string().uuid()).max(SERVE_MAX) }),
]);

/** What the PATCH body is read to, at most, to tell a "Can write" change
 *  (its changes are a mode, a flag or a served list). */
const SHARE_PATCH_PEEK_BYTES = 64 * 1024;

/**
 * The "Can write" a PATCH body asks, as PatchBody reads it (it tries `mode`
 * first, then `canWrite`): a boolean `canWrite` and no string `mode`; else
 * null. Read from a clone, capped, so the body is read again below; a body
 * that is not JSON asks no such change (answered below).
 */
async function asksCanWrite(req: Request): Promise<boolean | null> {
  try {
    const body = JSON.parse(await readBodyCapped(req.clone(), SHARE_PATCH_PEEK_BYTES)) as unknown;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
    const b = body as Record<string, unknown>;
    return typeof b.canWrite === 'boolean' && typeof b.mode !== 'string' ? b.canWrite : null;
  } catch {
    return null;
  }
}

/** PATCH /api/shares/[id] { serve } → `{ ok: true, served }`: replace an
 *  open link's served list (plan 8.1), with the checks of POST /api/shares:
 *  who may change the link (`mayLink`), and each id ADDED must be named or
 *  embedded by the item (a folder link: sit in the folder) and editable by
 *  the caller. 404 `not_found` (no such live open link, or an item or id
 *  the caller cannot read), 403 `forbidden`.
 *
 *  PATCH /api/shares/[id] { canWrite } → "Can write" on a contact share of
 *  an app (contact shares, 0214); 400 `write-not-app` on another kind.
 *  An Admin user's, its home not checked, as making one is
 *  (mantle_share_contact_write_set, plan v3.2 S6 c2). Audited
 *  (`contact.share_can_write`).
 *
 *  PATCH /api/shares/[id] { mode } → set the link's admission (owner-scoped).
 *  'public' is the only mode (a live link already is: this confirms it).
 *  'team' is refused with 400 `team-links-retired`: team links are retired
 *  (member logins Phase 6 stage 6), members use their own logins.
 *
 *  Any change but a contact share's "Can write" is the link's: asked first
 *  in the login's scope (shareItemRefusal), the item gate's 404 and 403. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await params;
  if (!UUID_RE.test(id)) return itemNotFound();
  const canWrite = await asksCanWrite(req);
  if (canWrite !== null) {
    const set = await adminSetContactShareCanWrite(user.actor.id, id, canWrite);
    if (set.outcome === 'not-found') {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    if (set.outcome === 'write-not-app') return writeNotApp();
    if (set.outcome === 'ok') {
      auditFireAndForget({
        actorId: user.actor.id,
        actorEmail: user.actor.email,
        action: 'contact.share_can_write',
        method: 'PATCH',
        path: '/api/shares/:id',
        detail: { shareId: id, contactId: set.contactId, value: canWrite },
        ...requestMetaFrom(req),
      });
      return NextResponse.json({ ok: true, canWrite });
    }
    // 'not-contact': the link's rule, below.
  }
  const refused = await shareItemRefusal(id);
  if (refused) return refused;
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
  // { canWrite } by the link's rule, in the login's scope: a share that
  // names no contact (none is live here), or a body past the peek's cap.
  if ('canWrite' in parsed.data) {
    const share = await getContactShare(user.id, id);
    if (!share) return NextResponse.json({ error: 'not found' }, { status: 404 });
    if (share.nodeType !== 'app') return writeNotApp();
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

/** A contact share of a kind other than an app: no contact writes it. */
function writeNotApp() {
  return NextResponse.json(
    { error: 'Only an app can let a contact write.', reason: 'write-not-app' },
    { status: 400 },
  );
}
