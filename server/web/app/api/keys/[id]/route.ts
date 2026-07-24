import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { deleteApiKey } from '@/lib/api-keys';

const IdParams = z.object({ id: z.string().uuid() });

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = IdParams.safeParse(await ctx.params);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  }
  const ok = await deleteApiKey(user.id, parsed.data.id);
  if (!ok) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
