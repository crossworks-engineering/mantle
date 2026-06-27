import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { deleteTable, getTable, updateTable } from '@/lib/tables';

const PatchBody = z.object({
  title: z.string().min(1).max(200).optional(),
  icon: z.string().max(16).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  visibility: z.enum(['private', 'public']).optional(),
});

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const row = await getTable(user.id, id);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ table: row });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  const row = await updateTable(user.id, id, parsed.data);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ table: row });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const ok = await deleteTable(user.id, id);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
