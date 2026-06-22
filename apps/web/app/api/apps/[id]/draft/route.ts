/**
 * /api/apps/[id]/draft — autosave the working source tree (PUT) or discard it
 * (DELETE). Mirrors the pages draft autosave: writes draft_source only; the
 * published app + its build are untouched until app_publish.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOwner } from '@/lib/auth';
import { saveDraftSource, discardAppDraft } from '@mantle/content';

export const runtime = 'nodejs';

const Body = z.object({
  entry: z.string().min(1).max(256),
  files: z.record(z.string().max(256), z.string().max(256 * 1024)),
});

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'invalid input' }, { status: 400 });
  if (Object.keys(parsed.data.files).length > 50) {
    return NextResponse.json({ error: 'too many files (max 50)' }, { status: 400 });
  }
  const ok = await saveDraftSource(user.id, id, parsed.data);
  if (!ok) return NextResponse.json({ error: 'app not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const { id } = await ctx.params;
  const ok = await discardAppDraft(user.id, id);
  if (!ok) return NextResponse.json({ error: 'app not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
