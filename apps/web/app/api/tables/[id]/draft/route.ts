import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { saveTableDraft } from '@/lib/tables';
import type { TableDoc } from '@mantle/content/table-model';

const Body = z.object({
  data: z.record(z.unknown()),
  if_rev: z.number().int().nonnegative().optional(),
});

/**
 * Autosave the working grid. Cheap: persists to the draft only — nothing is
 * rendered to other surfaces or indexed. Publishing happens via POST
 * .../commit. `if_rev` is the same etag the op route uses; the response
 * carries the new `draft_rev` so op batches and whole-doc saves interleave
 * without desyncing the client's etag (audit).
 */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid input' }, { status: 400 });
  }
  try {
    const result = await saveTableDraft(user.id, id, parsed.data.data as TableDoc, {
      ...(parsed.data.if_rev !== undefined ? { ifRev: parsed.data.if_rev } : {}),
    });
    if (!result) return NextResponse.json({ error: 'not found' }, { status: 404 });
    if (!result.ok) {
      return NextResponse.json(
        {
          error: 'draft changed since you loaded it — refetch and re-apply',
          current_rev: result.currentRev,
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true, draft_rev: result.draftRev });
  } catch (err) {
    // Truncation guard (plan §4): a whole-doc autosave past the materialize
    // window is refused loudly — the op route is the write path at that size.
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'draft save failed' },
      { status: 400 },
    );
  }
}
