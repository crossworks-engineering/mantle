import { NextResponse } from 'next/server';
import { requireOwner } from '@/lib/auth';
import { revokeShare } from '@/lib/shares';

/** DELETE /api/shares/[id] → revoke the link (owner-scoped). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const { id } = await params;
  const ok = await revokeShare(user.id, id);
  return NextResponse.json({ ok });
}
