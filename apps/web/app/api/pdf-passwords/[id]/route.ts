import { NextResponse } from 'next/server';
import { requireOwner } from '@/lib/auth';
import { deletePdfPassword } from '@mantle/content';

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const { id } = await ctx.params;
  const ok = await deletePdfPassword(user.id, id);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
