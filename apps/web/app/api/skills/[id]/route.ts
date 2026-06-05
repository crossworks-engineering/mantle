import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOwner } from '@/lib/auth';
import { deleteSkill, getSkill, updateSkill } from '@/lib/skills';

const IdParams = z.object({ id: z.string().uuid() });

const PatchBody = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(2000),
    instructions: z.string().max(40_000),
    defaultState: z.record(z.unknown()),
    enabled: z.boolean(),
  })
  .partial();

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const skill = await getSkill(user.id, idParsed.data.id);
  if (!skill) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ skill });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const raw = await req.json().catch(() => ({}));
  const parsed = PatchBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  const row = await updateSkill(user.id, idParsed.data.id, parsed.data);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ skill: row });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const ok = await deleteSkill(user.id, idParsed.data.id);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
