import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { AvatarSchema } from '@/lib/avatar-schema';
import { AgentMemoryConfigSchema } from '@/lib/agent-memory-config-schema';
import { createAgent, listAgents } from '@/lib/agents';
import { errorMessage } from '@mantle/std';
import { firstIssue } from '@/lib/zod-issue';
import { isUniqueViolation } from '@mantle/db';
import { AGENT_THINKING_EFFORTS } from '@mantle/content-core/thinking-tiers';

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const rows = await listAgents(user.id, { withExperience: true });
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

const Params = z
  .object({
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().min(1).max(1_000_000).optional(),
    top_p: z.number().min(0).max(1).optional(),
    // Per-agent opt-in for the follow-up suggester worker (the composer chip).
    suggest_follow_up: z.boolean().optional(),
    // How granted tools reach the model: full list, or a stable core + tool_search
    // (docs/tools-and-skills.md "Deferred tool loading"). Absent = full.
    tool_loading: z.enum(['full', 'deferred']).optional(),
  })
  .strict();

const Avatar = AvatarSchema;

const CreateBody = z.object({
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_-]+$/, 'slug must be lowercase letters/digits/dash'),
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
  skillSlugs: z.array(z.string().min(1).max(120)).max(32).optional(),
  toolGroupSlugs: z.array(z.string().min(1).max(120)).max(64).optional(),
  memoryConfig: AgentMemoryConfigSchema.optional(),
  params: Params.optional(),
  // Per-agent thinking effort (migration 0228). null/omitted = inherit the
  // person's profile setting.
  thinkingEffort: z.enum(AGENT_THINKING_EFFORTS).nullish(),
  avatar: Avatar.optional(),
  priority: z.number().int().min(0).max(1_000_000).optional(),
  enabled: z.boolean().optional(),
});

export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const raw = await req.json().catch(() => ({}));
  const parsed = CreateBody.safeParse(raw);
  if (!parsed.success) {
    const message = firstIssue(parsed.error, 'Invalid input.');
    return NextResponse.json({ error: message }, { status: 400 });
  }
  try {
    const row = await createAgent(user.id, parsed.data);
    return NextResponse.json({ agent: row });
  } catch (err) {
    const msg = errorMessage(err);
    if (isUniqueViolation(err)) {
      return NextResponse.json(
        { error: `An agent with slug "${parsed.data.slug}" already exists.` },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
