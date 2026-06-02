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
    // Responder/assistant-only.
    digest_limit: z.number().int().min(0).max(20).optional(),
    fact_limit: z.number().int().min(0).max(100).optional(),
    content_hit_limit: z.number().int().min(0).max(20).optional(),
    // Summarizer-only: threshold + batch for rolling old turns into digests.
    summarize_threshold: z.number().int().min(1).max(10_000).optional(),
    summarize_batch: z.number().int().min(1).max(1_000).optional(),
    // Extractor-only.
    extract_types: z.array(z.string().min(1).max(64)).max(32).optional(),
    extract_facts: z.boolean().optional(),
    extract_cost_cap_micro_usd: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
    // Agent-delegation allowlist: slugs this agent may invoke_agent into.
    // Empty array = delegation disabled (the runtime fails closed).
    delegate_to: z.array(z.string().min(1).max(120)).max(32).optional(),
    // Tool-result handling (KB): when a tool output exceeds inline_max_kb it
    // spills to the tool-result store; embed_min_kb is where the envelope
    // recommends semantic query. Fall back to env/global defaults.
    result_handling: z
      .object({
        inline_max_kb: z.number().int().min(1).max(1024).optional(),
        embed_min_kb: z.number().int().min(1).max(8192).optional(),
        spill_max_kb: z.number().int().min(1).max(65536).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const Params = z
  .object({
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().min(1).max(1_000_000).optional(),
    top_p: z.number().min(0).max(1).optional(),
  })
  .strict();

const Avatar = z
  .object({
    style: z.string().min(1).max(64),
    seed: z.string().min(1).max(200),
  })
  .strict()
  .nullable();

const CreateBody = z.object({
  slug: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/, 'slug must be lowercase letters/digits/dash'),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullish(),
  role: RoleEnum,
  // Provider id. Free-form string here; the runtime narrows it via
  // packages/voice/src/providers.ts and surfaces a clear error if a
  // chat adapter isn't registered. Defaults to 'openrouter' to match
  // the column default added in migration 0048.
  provider: z.string().min(1).max(64).default('openrouter'),
  model: z.string().min(1).max(200),
  apiKeyId: z.string().uuid().nullable(),
  // Optional BACKUP chat route (migration 0062). A chat backup may be a
  // DIFFERENT provider+model — that's what enables local-primary/cloud-fallback.
  backupProvider: z.string().min(1).max(64).nullish(),
  backupModel: z.string().min(1).max(200).nullish(),
  backupApiKeyId: z.string().uuid().nullish(),
  backupEnabled: z.boolean().optional(),
  // Per-route host + tailnet flag (migration 0063). baseUrl overrides the
  // provider default host (a self-hosted/tailnet box); viaTailnet routes
  // through the Tailscale proxy. Both routes carry their own pair.
  baseUrl: z.string().max(500).nullish(),
  viaTailnet: z.boolean().optional(),
  backupBaseUrl: z.string().max(500).nullish(),
  backupViaTailnet: z.boolean().optional(),
  // Per-agent voice (migration 0066): pin a kind='tts' ai_worker; null/omitted
  // = use the owner's default TTS worker.
  ttsWorkerId: z.string().uuid().nullish(),
  systemPrompt: z.string().min(1).max(40_000),
  tools: z.array(z.string()).max(256).optional(),
  toolSlugs: z.array(z.string().min(1).max(120)).max(256).optional(),
  skillSlugs: z.array(z.string().min(1).max(120)).max(32).optional(),
  memoryConfig: MemoryConfig.optional(),
  params: Params.optional(),
  avatar: Avatar.optional(),
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
