import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { clearEmbeddingModelCache } from '@mantle/embeddings';
import { ownerCaller } from '@/lib/auth';
import { setDefaultWorker, toAiWorkerDTO } from '@/lib/ai-workers';

const IdParams = z.object({ id: z.string().uuid() });

/** Make this worker the default for its kind (atomic swap — clears the prior
 *  default in the same transaction). */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const worker = await setDefaultWorker(user.id, idParsed.data.id);
  if (!worker) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (worker.kind === 'embedding') clearEmbeddingModelCache(user.id);
  return NextResponse.json({ worker: toAiWorkerDTO(worker) });
}
