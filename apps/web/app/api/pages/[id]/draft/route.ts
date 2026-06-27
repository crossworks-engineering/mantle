import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { saveDraft } from '@/lib/pages';

const Body = z.object({ doc: z.record(z.unknown()) });

/**
 * Autosave the working draft. Cheap: persists to `pages.draft_doc` only —
 * nothing is rendered to other surfaces or indexed. Publishing happens via
 * POST .../commit.
 */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid input' }, { status: 400 });
  }
  const ok = await saveDraft(user.id, id, parsed.data.doc);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
