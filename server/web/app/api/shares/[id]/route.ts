import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import {
  getContactShare,
  setContactShareCanWrite,
  TeamLinkRetiredError,
  unshareItem,
} from '@mantle/content';
import { applyShareMode } from '@/lib/shares';

/** DELETE /api/shares/[id] → revoke the link or contact share
 *  (owner-scoped): `{ ok }`. A plain revoke: who reads the item is its
 *  grants (workspaces W5b2), which a revoke leaves alone. The item's share
 *  dialog Remove and the contact's "Shared" tab Revoke both call this. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await params;
  const { revoked } = await unshareItem(user.id, id);
  return NextResponse.json({ ok: revoked });
}

const PatchBody = z.union([z.object({ mode: z.string() }), z.object({ canWrite: z.boolean() })]);

/** PATCH /api/shares/[id] { canWrite } → "Can write" on a contact share of
 *  an app (contact shares, 0214); 400 `write-not-app` on another kind.
 *  Audited (`contact.share_can_write`).
 *
 *  PATCH /api/shares/[id] { mode } → set the link's admission (owner-scoped).
 *  'public' is the only mode (a live link already is: this confirms it).
 *  'team' is refused with 400 `team-links-retired`: team links are retired
 *  (member logins Phase 6 stage 6), members use their own logins, and an
 *  item is shown to them by setting its level to team. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await params;
  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'invalid mode' }, { status: 400 });
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
