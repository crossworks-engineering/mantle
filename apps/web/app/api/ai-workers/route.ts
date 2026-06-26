import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { AiWorkerParams } from '@mantle/db';
import { requireOwner } from '@/lib/auth';
import { createAiWorker, listAiWorkers, toAiWorkerDTO } from '@/lib/ai-workers';

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
]);

/** Connection/route fields shared by create + patch (all optional on patch). */
const workerFields = {
  name: z.string().min(1).max(120),
  provider: z.string().min(1),
  model: z.string().min(1),
  apiKeyId: z.string().uuid().nullable().optional(),
  systemPrompt: z.string().nullable().optional(),
  params: z.record(z.unknown()).optional(),
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
  const user = await requireOwner();
  const rows = await listAiWorkers(user.id);
  return NextResponse.json({ workers: rows.map(toAiWorkerDTO) });
}

export async function POST(req: Request) {
  const user = await requireOwner();
  const parsed = CreateBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  try {
    const { params, ...rest } = parsed.data;
    // createAiWorker honours isDefault atomically in its own transaction.
    const worker = await createAiWorker({
      ownerId: user.id,
      ...rest,
      ...(params !== undefined ? { params: params as AiWorkerParams } : {}),
    });
    return NextResponse.json({ worker: toAiWorkerDTO(worker) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('duplicate key') || msg.includes('_uq')) {
      return NextResponse.json({ error: 'A worker with that slug already exists.' }, { status: 409 });
    }
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
