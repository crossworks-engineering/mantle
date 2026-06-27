import { NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
import { deletePdfPassword } from '@mantle/content';

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const ok = await deletePdfPassword(user.id, id);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
