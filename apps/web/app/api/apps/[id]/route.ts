/**
 * /api/apps/[id] — get (GET), update metadata (PATCH), delete (DELETE).
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOwner } from '@/lib/auth';
import { getApp, updateAppMeta, deleteApp } from '@mantle/content';

export const runtime = 'nodejs';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const { id } = await ctx.params;
  const app = await getApp(user.id, id);
  if (!app) return NextResponse.json({ error: 'app not found' }, { status: 404 });
  return NextResponse.json({ app });
}

const PatchBody = z.object({
  name: z.string().min(1).max(200).optional(),
  icon: z.string().max(16).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  visibility: z.enum(['private', 'public']).optional(),
});

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const { id } = await ctx.params;
  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid input' }, { status: 400 });
  }
  const { name, ...rest } = parsed.data;
  const app = await updateAppMeta(user.id, id, { ...(name ? { title: name } : {}), ...rest });
  if (!app) return NextResponse.json({ error: 'app not found' }, { status: 404 });
  return NextResponse.json({ app });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const { id } = await ctx.params;
  const ok = await deleteApp(user.id, id);
  if (!ok) return NextResponse.json({ error: 'app not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
