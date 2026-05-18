import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOwner } from '@/lib/auth';
import { createAgent, listAgents } from '@/lib/agents';

export async function GET() {
  const user = await requireOwner();
  const rows = await listAgents(user.id);
  return NextResponse.json({ agents: rows });
}

const RoleEnum = z.enum([
  'assistant',
  'responder',
  'extractor',
  'summarizer',
  'reflector',
  'custom',
]);

const MemoryConfig = z
  .object({
    history_limit: z.number().int().min(0).max(500).optional(),
    history_window_hours: z.number().min(0).max(24 * 365).nullable().optional(),
    // Responder-only: how many digest nodes to include in context.
    digest_limit: z.number().int().min(0).max(20).optional(),
    // Summarizer-only: threshold + batch for rolling old turns into digests.
    summarize_threshold: z.number().int().min(1).max(10_000).optional(),
    summarize_batch: z.number().int().min(1).max(1_000).optional(),
  })
  .strict();

const Params = z
  .object({
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().min(1).max(1_000_000).optional(),
    top_p: z.number().min(0).max(1).optional(),
  })
  .strict();

const CreateBody = z.object({
  slug: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/, 'slug must be lowercase letters/digits/dash'),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullish(),
  role: RoleEnum,
  model: z.string().min(1).max(200),
  apiKeyId: z.string().uuid().nullable(),
  systemPrompt: z.string().min(1).max(40_000),
  tools: z.array(z.string()).max(64).optional(),
  memoryConfig: MemoryConfig.optional(),
  params: Params.optional(),
  priority: z.number().int().min(0).max(1_000_000).optional(),
  enabled: z.boolean().optional(),
});

export async function POST(req: Request) {
  const user = await requireOwner();
  const raw = await req.json().catch(() => ({}));
  const parsed = CreateBody.safeParse(raw);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? 'Invalid input.';
    return NextResponse.json({ error: message }, { status: 400 });
  }
  try {
    const row = await createAgent(user.id, parsed.data);
    return NextResponse.json({ agent: row });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('agents_owner_slug_uq') || msg.includes('duplicate key')) {
      return NextResponse.json(
        { error: `An agent with slug "${parsed.data.slug}" already exists.` },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
