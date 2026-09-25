import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { AvatarSchema } from '@/lib/avatar-schema';
import { deleteAgent, updateAgent } from '@/lib/agents';
import { agentGrantProblems } from '@mantle/content';
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

const MemoryConfig = z
  .object({
    history_limit: z.number().int().min(0).max(500).optional(),
    history_window_hours: z
      .number()
      .min(0)
      .max(24 * 365)
      .nullable()
      .optional(),
    digest_limit: z.number().int().min(0).max(20).optional(),
    fact_limit: z.number().int().min(0).max(100).optional(),
    content_hit_limit: z.number().int().min(0).max(20).optional(),
    chunk_limit: z.number().int().min(0).max(50).optional(),
    corpus_map_limit: z.number().int().min(0).max(2_000).optional(),
    // Journal context (docs/journal.md §4a/§4b). notes_target = 'journal'
    // implies journal_tiers = 'live' at runtime.
    inject_journal: z.boolean().optional(),
    inject_working_notes: z.boolean().optional(),
    journal_tiers: z.enum(['off', 'shadow', 'live']).optional(),
    journal_relevance_min: z.number().min(0).max(1).optional(),
    journal_relevant_chars: z.number().int().min(200).max(20_000).optional(),
    notes_target: z.enum(['persona', 'journal']).optional(),
    summarize_threshold: z.number().int().min(1).max(10_000).optional(),
    summarize_batch: z.number().int().min(1).max(1_000).optional(),
    extract_types: z.array(z.string().min(1).max(64)).max(32).optional(),
    extract_facts: z.boolean().optional(),
    extract_cost_cap_micro_usd: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
    // Agent-delegation allowlist: slugs this agent may invoke_agent into.
    // Empty array = delegation disabled (the runtime fails closed).
    delegate_to: z.array(z.string().min(1).max(120)).max(32).optional(),
    // Tool-loop iteration cap (set per-specialist by the manifest; editable from
    // the Studio structure editor).
    max_iterations: z.number().int().min(1).max(100).optional(),
    // Per-turn tool-call caps (the manifest sets them on some specialists;
    // without them a UI round-trip of memory_config was rejected).
    max_tool_calls: z.number().int().min(1).max(200).optional(),
    max_calls_per_tool: z.number().int().min(1).max(100).optional(),
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
    // Per-agent opt-in for the follow-up suggester worker (the composer chip).
    suggest_follow_up: z.boolean().optional(),
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
    memoryConfig: MemoryConfig,
    params: Params,
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

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) {
    return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  }
  const ok = await deleteAgent(user.id, idParsed.data.id);
  if (!ok) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
