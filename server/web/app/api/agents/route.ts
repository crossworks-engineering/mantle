import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import {
  AGENT_ROUTES,
  ROUTE_KEY_REFS,
  modelRoutesRefusal,
  modelRoutesStamp,
} from '@/lib/model-route-pair';
import { toolMakerFor } from '@/lib/tools';
import { restampHeartbeatMakers } from '@mantle/tools';
import { AvatarSchema } from '@/lib/avatar-schema';
import { AgentMemoryConfigSchema } from '@/lib/agent-memory-config-schema';
import { agentForReader, createAgent, listAgents } from '@/lib/agents';
import { firstIssue } from '@/lib/zod-issue';
import { conflictOnUnique, inputOnMissingRef } from '@mantle/db';
import { AGENT_THINKING_EFFORTS } from '@mantle/content-core/thinking-tiers';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';
import { modelPolicyBody, modelRoutesPolicyIssue } from '@/lib/model-policy-save';

export const policy = routePolicy({
  GET: { class: 'area', area: 'assistants' },
  POST: {
    class: 'area',
    area: 'assistants',
    item: { none: 'manages the assistants area: the Admin step checks it' },
  },
});

export async function GET() {
  const user = ownerCaller();
  const rows = await listAgents(user.id, { withExperience: true });
  return NextResponse.json({ agents: rows.map((a) => agentForReader(user, a)) });
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
  const user = ownerCaller();
  const raw = await readJson(req);
  const parsed = CreateBody.safeParse(raw);
  if (!parsed.success) {
    const message = firstIssue(parsed.error, 'Invalid input.');
    return NextResponse.json({ error: message }, { status: 400 });
  }
  // The box policy's model block (lib/model-policy-save.ts): no blocked
  // model is saved by hand. A backup that is off runs nothing: not checked.
  const blocked = modelRoutesPolicyIssue([
    [parsed.data.provider ?? 'openrouter', parsed.data.model, parsed.data.baseUrl],
    [
      parsed.data.backupEnabled ? parsed.data.backupProvider : null,
      parsed.data.backupModel,
      parsed.data.backupBaseUrl,
    ],
  ]);
  if (blocked) return NextResponse.json(modelPolicyBody(blocked), { status: 403 });
  // A key with a base URL of the writer's choosing is the keys area's
  // (lib/model-route-pair.ts).
  const keysRefused = await modelRoutesRefusal(user, null, parsed.data, AGENT_ROUTES);
  if (keysRefused) return NextResponse.json({ error: keysRefused }, { status: 403 });
  // A slug or name taken answers 409 with this route's own text
  // (conflictOnUnique, a ConflictError); anything else answers by the one
  // table: a domain error its status, a fault the opaque 500.
  return conflictOnUnique(`An agent with slug "${parsed.data.slug}" already exists.`, async () => {
    // A key id the vault has no key for is the caller's 400.
    const row = await inputOnMissingRef(ROUTE_KEY_REFS.agents, () =>
      createAgent(user.id, {
        ...parsed.data,
        ...modelRoutesStamp(user, null, parsed.data, AGENT_ROUTES),
      }),
    );
    // A heartbeat already bound to this slug runs this prompt from now on
    // (@mantle/tools heartbeat-maker.ts).
    await restampHeartbeatMakers(user.id, toolMakerFor(user), { agentSlug: row.slug });
    return NextResponse.json({ agent: agentForReader(user, row) });
  });
}
