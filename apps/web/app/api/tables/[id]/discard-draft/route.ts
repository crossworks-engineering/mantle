import { NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
import { discardTableDraft } from '@/lib/tables';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const ok = await discardTableDraft(user.id, id);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
