import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { inputOnMissingRef, type AiWorker, type AiWorkerParams } from '@mantle/db';
import { clearEmbeddingModelCache } from '@mantle/embeddings';
import { ownerCaller } from '@/lib/auth';
import {
  deleteAiWorker,
  getAiWorker,
  openRouterModelIssue,
  toAiWorkerDTO,
  updateAiWorker,
} from '@/lib/ai-workers';
import {
  AGENT_ROUTES,
  ROUTE_KEY_REFS,
  modelRoutesRefusal,
  modelRoutesStamp,
  modelRoutesTouched,
} from '@/lib/model-route-pair';
import { readBody } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'settings' },
  PATCH: {
    class: 'area',
    area: 'settings',
    item: { none: 'manages the settings area: the Admin step checks it' },
  },
  DELETE: {
    class: 'area',
    area: 'settings',
    item: { none: 'manages the settings area: the Admin step checks it' },
  },
});

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
  const user = ownerCaller();
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const worker = await getAiWorker(user.id, idParsed.data.id);
  if (!worker) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ worker: toAiWorkerDTO(worker) });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const body = await readBody(req, PatchBody);
  const { params, ...rest } = body;
  // A vault key (the key id, or the provider's key a route without one falls
  // back to) with a base URL of the writer's choosing is the keys area's,
  // and the row records who paired them (W7a fix rounds 4 and 5,
  // lib/model-route-pair.ts).
  let configuredBy: Pick<Partial<AiWorker>, 'configuredBy'> = {};
  if (modelRoutesTouched(rest, AGENT_ROUTES)) {
    const stored = await getAiWorker(user.id, idParsed.data.id);
    if (!stored) return NextResponse.json({ error: 'not found' }, { status: 404 });
    const refused = await modelRoutesRefusal(user, stored, rest, AGENT_ROUTES);
    if (refused) return NextResponse.json({ error: refused }, { status: 403 });
    configuredBy = modelRoutesStamp(user, stored, rest, AGENT_ROUTES);
  }
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
  // A key id the vault has no key for is the caller's 400 (A10 lows).
  const worker = await inputOnMissingRef(ROUTE_KEY_REFS.aiWorkers, () =>
    updateAiWorker(user.id, idParsed.data.id, {
      ...rest,
      ...configuredBy,
      ...(params !== undefined ? { params: params as AiWorkerParams } : {}),
    }),
  );
  if (!worker) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (worker.kind === 'embedding') clearEmbeddingModelCache(user.id);
  return NextResponse.json({ worker: toAiWorkerDTO(worker) });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  // Read the kind before deleting so we can drop the embedding cache if needed.
  const existing = await getAiWorker(user.id, idParsed.data.id);
  const ok = await deleteAiWorker(user.id, idParsed.data.id);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (existing?.kind === 'embedding') clearEmbeddingModelCache(user.id);
  return NextResponse.json({ ok: true });
}
