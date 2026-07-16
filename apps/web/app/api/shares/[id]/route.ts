import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { revokeShareTree, applyShareMode } from '@/lib/shares';

/** DELETE /api/shares/[id] → revoke the link (owner-scoped). If the share
 *  cascades to its subtree, the descendant links are revoked too. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await params;
  const ok = await revokeShareTree(user.id, id);
  return NextResponse.json({ ok });
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
