import { NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
import { revokeShare } from '@/lib/shares';

/** DELETE /api/shares/[id] → revoke the link (owner-scoped). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await params;
  const ok = await revokeShare(user.id, id);
  return NextResponse.json({ ok });
}
