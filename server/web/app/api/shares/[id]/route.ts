import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { TeamLinkRetiredError, unshareItem } from '@mantle/content';
import { applyShareMode } from '@/lib/shares';

/** DELETE /api/shares/[id] → revoke the link (owner-scoped). Removing
 *  an open link puts the item at admin with the same closure rule as the
 *  Access control: `stillBelow` lists what it embeds that is still below
 *  admin (raise it with PATCH /api/access/nodes/:id { audience: 'admin',
 *  raiseClosure: true }). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await params;
  const { revoked, stillBelow } = await unshareItem(user.id, id);
  return NextResponse.json({ ok: revoked, stillBelow });
}

const PatchBody = z.object({ mode: z.string() });

/** PATCH /api/shares/[id] { mode } → set the link's admission (owner-scoped).
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
