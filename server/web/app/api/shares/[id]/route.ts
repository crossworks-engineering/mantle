import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { unshareItem } from '@mantle/content';
import { applyShareMode } from '@/lib/shares';

/** DELETE /api/shares/[id] → revoke the link (owner-scoped). If the share
 *  cascades to its subtree, the descendant links are revoked too. Removing
 *  an open link puts the item at admin with the same closure rule as the
 *  Access control: `stillBelow` lists what it embeds that is still below
 *  admin (raise it with PATCH /api/access/nodes/:id { audience: 'admin',
 *  raiseClosure: true }). Removing a team link leaves the item at team
 *  (`keptTeam: true`): member logins still read it. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await params;
  const { revoked, stillBelow, keptTeam } = await unshareItem(user.id, id);
  return NextResponse.json({ ok: revoked, stillBelow, ...(keptTeam ? { keptTeam } : {}) });
}

const PatchBody = z.object({ mode: z.enum(['public', 'team']) });

/** PATCH /api/shares/[id] { mode } → switch public/team admission (owner-scoped).
 *  When the share cascades to its subtree, the descendant links switch too. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await params;
  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'invalid mode' }, { status: 400 });
  const ok = await applyShareMode(user.id, id, parsed.data.mode);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
