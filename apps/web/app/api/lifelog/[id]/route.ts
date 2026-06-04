import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOwner } from '@/lib/auth';
import { deleteLifelog, getLifelog, updateLifelog } from '@/lib/lifelog';

const PatchBody = z.object({
  body: z.string().max(20_000).optional(),
  title: z.string().max(200).optional(),
  // Empty string clears the field (mood/category/entryDate are optional).
  mood: z.string().max(40).optional(),
  category: z.string().max(40).optional(),
  entryDate: z.string().max(40).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
});

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const { id } = await ctx.params;
  const row = await getLifelog(user.id, id);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ lifelog: row });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const { id } = await ctx.params;
  const raw = await req.json().catch(() => ({}));
  const parsed = PatchBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  let row;
  try {
    row = await updateLifelog(user.id, id, parsed.data);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'invalid input' },
      { status: 400 },
    );
  }
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ lifelog: row });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const { id } = await ctx.params;
  const ok = await deleteLifelog(user.id, id);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
