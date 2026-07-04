import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { revokeShare } from '@/lib/shares';
import { setShareMode } from '@mantle/content';

/** DELETE /api/shares/[id] → revoke the link (owner-scoped). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await params;
  const ok = await revokeShare(user.id, id);
  return NextResponse.json({ ok });
}

const PatchBody = z.object({ mode: z.enum(['public', 'team']) });

/** PATCH /api/shares/[id] { mode } → switch public/team admission (owner-scoped). */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await params;
  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'invalid mode' }, { status: 400 });
  const ok = await setShareMode(user.id, id, parsed.data.mode);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
