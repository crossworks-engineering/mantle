import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { deleteDraw, getDraw, updateDraw } from '@/lib/draws';

const PatchBody = z.object({
  title: z.string().min(1).max(200).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  visibility: z.enum(['private', 'public']).optional(),
  // Emoji beside the title; '' clears it — same contract as pages.
  icon: z.string().max(16).optional(),
  // User-authored one-liner (distinct from the extractor's summary); '' clears.
  description: z.string().max(500).optional(),
});

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const row = await getDraw(user.id, id);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ draw: row });
}

/** Metadata only (title/tags/visibility — live saves, never indexed).
 *  Scene writes go exclusively through .../draft and .../commit. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const raw = await req.json().catch(() => ({}));
  const parsed = PatchBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  const row = await updateDraw(user.id, id, parsed.data);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ draw: row });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const ok = await deleteDraw(user.id, id);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
