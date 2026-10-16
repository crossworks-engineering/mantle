import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { AvatarSchema } from '@/lib/avatar-schema';
import { AgentMemoryConfigSchema } from '@/lib/agent-memory-config-schema';
import { agentForReader, deleteAgent, updateAgent } from '@/lib/agents';
import { AGENT_THINKING_EFFORTS } from '@mantle/content';
import { agents, db, inputOnMissingRef } from '@mantle/db';
import { and, eq } from 'drizzle-orm';
import { firstIssue } from '@/lib/zod-issue';
import {
  AGENT_ROUTES,
  ROUTE_KEY_REFS,
  modelRoutesRepaired,
  modelRoutesTouched,
} from '@/lib/model-route-pair';
import { toolMakerFor, vaultPairRefusalFor } from '@/lib/tools';
import { restampHeartbeatMakers } from '@mantle/tools';
import { readJson } from '@/lib/read-body';

const IdParams = z.object({ id: z.string().uuid() });

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

const PatchBody = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(2000).nullable(),
    role: RoleEnum,
    provider: z.string().min(1).max(64),
    model: z.string().min(1).max(200),
    apiKeyId: z.string().uuid().nullable(),
    // Optional BACKUP chat route (migration 0062) — may be a different model.
    backupProvider: z.string().min(1).max(64).nullable(),
    backupModel: z.string().min(1).max(200).nullable(),
    backupApiKeyId: z.string().uuid().nullable(),
    backupEnabled: z.boolean(),
    // Per-route host + tailnet flag (migration 0063).
    baseUrl: z.string().max(500).nullable(),
    viaTailnet: z.boolean(),
    backupBaseUrl: z.string().max(500).nullable(),
    backupViaTailnet: z.boolean(),
    // Per-agent voice (migration 0066): pin a kind='tts' ai_worker; null = default.
    ttsWorkerId: z.string().uuid().nullable(),
    systemPrompt: z.string().min(1).max(40_000),
    skillSlugs: z.array(z.string().min(1).max(120)).max(32),
    toolGroupSlugs: z.array(z.string().min(1).max(120)).max(64),
    // Merged onto the stored value; null clears a key (see the schema).
    memoryConfig: AgentMemoryConfigSchema,
    params: Params,
    // Per-agent thinking effort (migration 0228). null = inherit the person's
    // profile setting.
    thinkingEffort: z.enum(AGENT_THINKING_EFFORTS).nullable(),
    avatar: Avatar,
    priority: z.number().int().min(0).max(1_000_000),
    enabled: z.boolean(),
  })
  .partial();

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) {
    return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  }
  const raw = await readJson(req);
  const parsed = PatchBody.safeParse(raw);
  if (!parsed.success) {
    const message = firstIssue(parsed.error, 'Invalid input.');
    return NextResponse.json({ error: message }, { status: 400 });
  }
  // A vault key (the key id, or the provider's key a route without one falls
  // back to) with a base URL of the writer's choosing is the keys area's,
  // and the row records who paired them (W7a fix rounds 4 and 5,
  // lib/model-route-pair.ts).
  let configuredBy: { configuredBy?: string | null } = {};
  if (modelRoutesTouched(parsed.data, AGENT_ROUTES)) {
    const [stored] = await db
      .select({
        provider: agents.provider,
        apiKeyId: agents.apiKeyId,
        baseUrl: agents.baseUrl,
        backupProvider: agents.backupProvider,
        backupApiKeyId: agents.backupApiKeyId,
        backupBaseUrl: agents.backupBaseUrl,
      })
      .from(agents)
      .where(and(eq(agents.id, idParsed.data.id), eq(agents.ownerId, user.id)))
      .limit(1);
    if (stored && modelRoutesRepaired(stored, parsed.data, AGENT_ROUTES)) {
      const refused = await vaultPairRefusalFor(user);
      if (refused) return NextResponse.json({ error: refused }, { status: 403 });
      configuredBy = { configuredBy: toolMakerFor(user) };
    }
  }
  // A key id the vault has no key for is the caller's 400 (A10 lows).
  const row = await inputOnMissingRef(ROUTE_KEY_REFS.agents, () =>
    updateAgent(user.id, idParsed.data.id, { ...parsed.data, ...configuredBy }),
  );
  if (!row) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  // The agent's prompt (system prompt and its skills) and its granted
  // groups (their tools and usage skills) are what its heartbeats run: a
  // login other than the anchor editing them makes them its own (W7a fix
  // rounds 4 and 5, @mantle/tools heartbeat-maker.ts). The same prompt also
  // answers the anchor's own chat with this agent.
  if (
    parsed.data.systemPrompt !== undefined ||
    parsed.data.skillSlugs !== undefined ||
    parsed.data.toolGroupSlugs !== undefined
  ) {
    await restampHeartbeatMakers(user.id, toolMakerFor(user), { agentSlug: row.slug });
  }
  return NextResponse.json({ agent: agentForReader(user, row) });
}

// `?conversation=keep|delete`. Absent = keep, the pre-existing behaviour, so a
// client that sends a bare DELETE is unchanged. See deleteAgent.
const ConversationParam = z.enum(['keep', 'delete']).default('keep');

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) {
    return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  }
  const modeRaw = new URL(req.url).searchParams.get('conversation') ?? undefined;
  const mode = ConversationParam.safeParse(modeRaw);
  if (!mode.success) {
    return NextResponse.json({ error: 'conversation must be keep or delete.' }, { status: 400 });
  }
  const result = await deleteAgent(user.id, idParsed.data.id, { conversation: mode.data });
  if (!result) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  return NextResponse.json({ ok: true, ...result });
}
