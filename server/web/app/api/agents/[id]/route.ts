import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { AvatarSchema } from '@/lib/avatar-schema';
import { AgentMemoryConfigSchema } from '@/lib/agent-memory-config-schema';
import { deleteAgent, updateAgent } from '@/lib/agents';
import { AGENT_THINKING_EFFORTS, agentGrantProblems } from '@mantle/content';
import { agents, db, isViewerLevel } from '@mantle/db';
import { and, eq } from 'drizzle-orm';
import { firstIssue } from '@/lib/zod-issue';

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
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) {
    return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  }
  const raw = await req.json().catch(() => ({}));
  const parsed = PatchBody.safeParse(raw);
  if (!parsed.success) {
    const message = firstIssue(parsed.error, 'Invalid input.');
    return NextResponse.json({ error: message }, { status: 400 });
  }
  // Level rule (member logins Phase 0b): an agent may hold only tool groups
  // at or below its own level.
  if (parsed.data.toolGroupSlugs) {
    const [current] = await db
      .select({ audience: agents.audience })
      .from(agents)
      .where(and(eq(agents.id, idParsed.data.id), eq(agents.ownerId, user.id)))
      .limit(1);
    if (current) {
      const problems = await agentGrantProblems(
        user.id,
        isViewerLevel(current.audience) ? current.audience : 'admin',
        parsed.data.toolGroupSlugs,
      );
      if (problems.length > 0) {
        return NextResponse.json({ error: problems.join('; ') }, { status: 400 });
      }
    }
  }
  const row = await updateAgent(user.id, idParsed.data.id, parsed.data);
  if (!row) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  return NextResponse.json({ agent: row });
}

// `?conversation=keep|delete`. Absent = keep, the pre-existing behaviour, so a
// client that sends a bare DELETE is unchanged. See deleteAgent.
const ConversationParam = z.enum(['keep', 'delete']).default('keep');

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
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
