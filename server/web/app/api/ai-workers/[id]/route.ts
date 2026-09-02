import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import type { AiWorkerParams } from '@mantle/db';
import { clearEmbeddingModelCache } from '@mantle/embeddings';
import { getOwnerOr401 } from '@/lib/auth';
import {
  deleteAiWorker,
  getAiWorker,
  openRouterModelIssue,
  toAiWorkerDTO,
  updateAiWorker,
} from '@/lib/ai-workers';
import { firstIssue } from '@/lib/zod-issue';

const IdParams = z.object({ id: z.string().uuid() });

/** Patchable fields (kind + slug are immutable; default flips via [id]/default). */
const PatchBody = z
  .object({
    name: z.string().min(1).max(120).optional(),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    apiKeyId: z.string().uuid().nullable().optional(),
    systemPrompt: z.string().nullable().optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    enabled: z.boolean().optional(),
    priority: z.number().int().optional(),
    backupProvider: z.string().nullable().optional(),
    backupModel: z.string().nullable().optional(),
    backupApiKeyId: z.string().uuid().nullable().optional(),
    backupEnabled: z.boolean().optional(),
    baseUrl: z.string().nullable().optional(),
    viaTailnet: z.boolean().optional(),
    backupBaseUrl: z.string().nullable().optional(),
    backupViaTailnet: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'nothing to update');

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const worker = await getAiWorker(user.id, idParsed.data.id);
  if (!worker) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ worker: toAiWorkerDTO(worker) });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  const { params, ...rest } = parsed.data;
  // Save-time catalog check against the EFFECTIVE post-patch config — a
  // patch may change only the model, only the provider, or both. Fail-open
  // when the catalog is unreachable (see openRouterModelIssue).
  if (rest.model !== undefined || rest.provider !== undefined || rest.backupModel !== undefined) {
    const existing = await getAiWorker(user.id, idParsed.data.id);
    if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 });
    for (const [provider, model] of [
      [rest.provider ?? existing.provider, rest.model ?? existing.model],
      [
        rest.backupProvider !== undefined ? rest.backupProvider : existing.backupProvider,
        rest.backupModel !== undefined ? rest.backupModel : existing.backupModel,
      ],
    ] as const) {
      const issue = await openRouterModelIssue({ kind: existing.kind, provider, model });
      if (issue) return NextResponse.json({ error: issue }, { status: 400 });
    }
  }
  const worker = await updateAiWorker(user.id, idParsed.data.id, {
    ...rest,
    ...(params !== undefined ? { params: params as AiWorkerParams } : {}),
  });
  if (!worker) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (worker.kind === 'embedding') clearEmbeddingModelCache(user.id);
  return NextResponse.json({ worker: toAiWorkerDTO(worker) });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  // Read the kind before deleting so we can drop the embedding cache if needed.
  const existing = await getAiWorker(user.id, idParsed.data.id);
  const ok = await deleteAiWorker(user.id, idParsed.data.id);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (existing?.kind === 'embedding') clearEmbeddingModelCache(user.id);
  return NextResponse.json({ ok: true });
}
