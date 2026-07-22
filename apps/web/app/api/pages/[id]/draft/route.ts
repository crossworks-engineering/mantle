import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { saveDraft } from '@/lib/pages';

const Body = z.object({
  doc: z.record(z.string(), z.unknown()),
  if_rev: z.number().int().nonnegative().optional(),
});

/**
 * Autosave the working draft. Cheap: persists to `pages.draft_doc` only —
 * nothing is rendered to other surfaces or indexed. Publishing happens via
 * POST .../commit. `if_rev` is the draft etag: a stale value returns 409 with
 * the current server rev (the client resyncs) instead of clobbering newer
 * edits; the success body carries the new `draft_rev` for the client to adopt.
 */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid input' }, { status: 400 });
  }
  const result = await saveDraft(user.id, id, parsed.data.doc, {
    ...(parsed.data.if_rev !== undefined ? { baseRev: parsed.data.if_rev } : {}),
  });
  if (!result.ok) {
    if ('conflict' in result) {
      return NextResponse.json(
        {
          error: 'draft changed since you loaded it — refetch and re-apply',
          current_rev: result.rev,
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true, draft_rev: result.rev });
}
