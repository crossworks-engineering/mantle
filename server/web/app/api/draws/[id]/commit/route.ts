import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { commitDraw, sceneToText, SCENE_SVG_MAX_BYTES } from '@/lib/draws';
import { recordIngest } from '@mantle/tracing';

const Body = z.object({
  scene: z.record(z.string(), z.unknown()),
  /** exportToSvg output captured by the committing editor. Validated
   *  server-side (acceptSceneSvg); dropped, never fatal, on any doubt. */
  svg: z.string().max(SCENE_SVG_MAX_BYTES).optional(),
  if_rev: z.number().int().nonnegative().optional(),
});

/**
 * Commit: publish the scene and index it. The only moment a draw body
 * reaches the brain (extractor: summary + embedding + facts), so it opens a
 * content_ingest trace. `if_rev` semantics identical to the pages commit:
 * stale rev returns 409 and NOTHING is published.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid input' }, { status: 400 });
  }
  const result = await commitDraw(user.id, id, parsed.data.scene, {
    ...(parsed.data.if_rev !== undefined ? { baseRev: parsed.data.if_rev } : {}),
    ...(parsed.data.svg !== undefined ? { svg: parsed.data.svg } : {}),
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
  const draw = result.draw;

  const snippet = sceneToText(draw.scene);
  void recordIngest({
    source: 'draw_commit',
    ownerId: user.id,
    nodeId: draw.id,
    summary: `Drawing committed: ${draw.title.slice(0, 80)}`,
    payload: { title: draw.title, tags: draw.tags, textChars: snippet.length, via: 'web_api' },
    snippet,
  });
  return NextResponse.json({ draw });
}
