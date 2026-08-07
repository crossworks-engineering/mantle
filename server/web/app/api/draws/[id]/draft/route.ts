import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { saveDrawDraft, sceneWithinLimits } from '@/lib/draws';

const Body = z.object({
  // Bounded: this is the hot path (every ~1.5 s while drawing) into an
  // unbounded jsonb column, and no framework body limit stands in front of it.
  scene: z
    .record(z.string(), z.unknown())
    .refine(sceneWithinLimits, { message: 'scene too large' }),
  /** BinaryFile id → file node id. Present when the editor uploaded new
   *  scene images through the files pipeline; replaces the stored map. */
  file_refs: z.record(z.string(), z.string().uuid()).optional(),
  if_rev: z.number().int().nonnegative().optional(),
});

/**
 * Autosave the working draft. Cheap and frequent (the canvas edits
 * continuously): persists to `draws.draft_scene` only — nothing is rendered
 * to other surfaces or indexed. Publishing happens via POST .../commit.
 * `if_rev` is the draft etag: a stale value returns 409 with the current
 * server rev instead of clobbering newer edits.
 */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    const tooLarge = parsed.error.issues.some((i) => i.message === 'scene too large');
    return NextResponse.json(
      { error: tooLarge ? 'scene too large' : 'invalid input' },
      { status: tooLarge ? 413 : 400 },
    );
  }
  const result = await saveDrawDraft(user.id, id, parsed.data.scene, {
    ...(parsed.data.if_rev !== undefined ? { baseRev: parsed.data.if_rev } : {}),
    ...(parsed.data.file_refs !== undefined ? { fileRefs: parsed.data.file_refs } : {}),
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
