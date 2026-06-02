import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOwner } from '@/lib/auth';
import { saveTableDraft } from '@/lib/tables';
import type { TableDoc } from '@mantle/content/table-model';

const Body = z.object({ data: z.record(z.unknown()) });

/**
 * Autosave the working grid. Cheap: persists to `tables.draft_data` only —
 * nothing is rendered to other surfaces or indexed. Publishing happens via
 * POST .../commit.
 */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid input' }, { status: 400 });
  }
  const ok = await saveTableDraft(user.id, id, parsed.data.data as TableDoc);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
