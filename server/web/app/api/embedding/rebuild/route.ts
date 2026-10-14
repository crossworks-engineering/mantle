import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { resolveEmbeddingModel, runReembed } from '@mantle/embeddings';
import { ownerCaller } from '@/lib/auth';
import { errorMessage } from '@mantle/std';
import { readJson } from '@/lib/read-body';

const Body = z.object({ repopulate: z.boolean().optional() });

/**
 * Re-embed the corpus against the saved model. Idempotent under the
 * embedding_cache, so re-running on an unchanged model is cheap.
 */
export async function POST(req: Request) {
  const user = ownerCaller();
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) return NextResponse.json({ ok: false, error: 'invalid input' });
  try {
    const model = await resolveEmbeddingModel(user.id);
    const result = await runReembed(user.id, {
      model,
      includeUnembedded: parsed.data.repopulate ?? false,
    });
    return NextResponse.json({ ok: true, model, result });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: errorMessage(err),
    });
  }
}
