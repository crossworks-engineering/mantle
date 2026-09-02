import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import type { AiWorkerParams } from '@mantle/db';
import { clearEmbeddingModelCache } from '@mantle/embeddings';
import { getOwnerOr401 } from '@/lib/auth';
import {
  createAiWorker,
  listAiWorkers,
  openRouterModelIssue,
  toAiWorkerDTO,
} from '@/lib/ai-workers';
import { errorMessage } from '@mantle/std';
import { firstIssue } from '@/lib/zod-issue';

const KIND = z.enum([
  'reflector',
  'extractor',
  'summarizer',
  'tts',
  'stt',
  'vision',
  'document',
  'image_gen',
  'embedding',
  'search',
  'search_advanced',
  'narrator',
  'suggester',
]);

/** Connection/route fields shared by create + patch (all optional on patch). */
const workerFields = {
  name: z.string().min(1).max(120),
  provider: z.string().min(1),
  model: z.string().min(1),
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
};

const CreateBody = z.object({
  kind: KIND,
  slug: z.string().min(1).max(120).optional(),
  isDefault: z.boolean().optional(),
  ...workerFields,
});

/** All workers for the owner, ordered by kind then priority. */
export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const rows = await listAiWorkers(user.id);
  return NextResponse.json({ workers: rows.map(toAiWorkerDTO) });
}

export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = CreateBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  // Save-time catalog check: a bad OpenRouter id fails SILENTLY at call time
  // (the 2026-08-31 vision incident), so the save is where it must be caught.
  // Fail-open when the catalog is unreachable.
  for (const [provider, model] of [
    [parsed.data.provider, parsed.data.model],
    [parsed.data.backupProvider, parsed.data.backupModel],
  ] as const) {
    const issue = await openRouterModelIssue({ kind: parsed.data.kind, provider, model });
    if (issue) return NextResponse.json({ error: issue }, { status: 400 });
  }
  try {
    const { params, ...rest } = parsed.data;
    // createAiWorker honours isDefault atomically in its own transaction.
    const worker = await createAiWorker({
      ownerId: user.id,
      ...rest,
      ...(params !== undefined ? { params: params as AiWorkerParams } : {}),
    });
    // Embedding model changes must drop the resolver cache NOW (next ingest/recall
    // would otherwise hit the old model for ~60s).
    if (worker.kind === 'embedding') clearEmbeddingModelCache(user.id);
    return NextResponse.json({ worker: toAiWorkerDTO(worker) });
  } catch (err) {
    const msg = errorMessage(err);
    if (msg.includes('duplicate key') || msg.includes('_uq')) {
      return NextResponse.json(
        { error: 'A worker with that slug already exists.' },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
