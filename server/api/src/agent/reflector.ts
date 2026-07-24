/**
 * Reflector — Stage-E agent. Slow background pass that watches recent
 * dialog for relationship signals (style preferences, corrections, in-
 * jokes) and appends them to a conversational agent's `persona_notes`.
 *
 * Not triggered per-turn — runs on a timer (default every 10 minutes) and
 * short-circuits if there's been no new outbound activity since the last
 * run. Decoupling from the reply path matters: reflection is a slow,
 * possibly-expensive read across many turns, and we don't want it on the
 * critical path for the user's next message.
 *
 * Role-decoupled (docs/comms-channels.md §6): reflection no longer targets
 * "the responder". It runs on EVERY enabled conversational agent the user has
 * actually been talking to — gated on real conversation activity (≥1 new
 * outbound turn in the unified `assistant_messages` stream since the last run),
 * NOT on all agents (cost-safety: only agents with genuine activity get an LLM
 * call). Bounded by `MAX_AGENTS_PER_RUN` per tick. Each agent's notes are
 * learned from its own per-(owner, agent) transcript.
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import {
  db,
  agents,
  activeNotes,
  assistantMessages,
  bumpWorkerUsage,
  capNotes,
  dedupeNewNotes,
  getDefaultWorker,
  MAX_PERSONA_NOTES,
  type Agent,
  type AiWorker,
  type PersonaNote,
  type ReflectorParams,
} from '@mantle/db';
import { recordSkippedTrace, startTrace, step } from '@mantle/tracing';
import {
  chatWithFailover,
  recordChatUsage,
  resolveChatKey,
  resolveChatRoutes,
} from '@mantle/agent-runtime';
import { CONVERSATIONAL_ROLES, rankActiveAgents } from './agent-select.js';

/** How many recent turns the reflector reviews per agent per run. */
const REFLECTION_WINDOW = 50;

/** Cost-safety cap: at most this many agents get an LLM reflection per tick.
 *  Only agents with NEW activity since the last run qualify, so this only bites
 *  in the rare case of many simultaneously-active conversational agents — the
 *  rest are picked up on the next tick. Most-active-first. */
const MAX_AGENTS_PER_RUN = 5;

export const DEFAULT_REFLECTOR_PROMPT = `You are a reflector for a personal AI assistant. You will be given a transcript of recent exchanges between the user and the assistant, plus the assistant's current persona_notes (preferences, relationship notes, corrections already learned).

Your job: spot NEW signals worth remembering, AND ONLY new ones.

Look for:
  • style hints       — how the user wants to be addressed, response format preferences ("be terse", "skip bullet lists")
  • relationship notes — facts about how the user and the assistant interact ("the user calls me 'S' for short", "the user uses dry humour")
  • corrections        — when the user told the assistant it got something wrong ("not Sarah-with-an-h; Sarah-without")

Output STRICT JSON, no markdown:

{
  "new_notes": [
    {
      "kind": "style" | "relationship" | "correction",
      "content": "<single declarative sentence>"
    }
  ]
}

Rules:
- Skip anything already covered by an existing persona_note (read the list before deciding).
- Be specific — "the user prefers terse, no-bullet replies" beats "user likes brevity".
- Don't invent — only return notes grounded in the transcript.
- Return an EMPTY new_notes array if nothing notable surfaces.
- Don't include trivia about content (those belong in facts, not persona).`;

/** Find this owner's reflector worker (kind='reflector'). Returns
 *  null if none is configured — `reflect()` short-circuits cleanly. */
async function resolveReflector(ownerId: string): Promise<AiWorker | null> {
  return await getDefaultWorker(ownerId, 'reflector');
}

/**
 * Enabled conversational agents with NEW outbound activity since `since`, in
 * the unified `assistant_messages` stream (which carries web + Telegram + any
 * future channel — docs/conversation.md). Most-active-first. This is the
 * cost-safety gate: an agent only earns an LLM reflection if the user actually
 * conversed with it since the last run.
 */
async function qualifyingAgents(ownerId: string, since: Date): Promise<Agent[]> {
  const candidates = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.ownerId, ownerId),
        eq(agents.enabled, true),
        inArray(agents.role, [...CONVERSATIONAL_ROLES]),
      ),
    );
  if (candidates.length === 0) return [];

  const counts = await db
    .select({ agentId: assistantMessages.agentId, n: sql<number>`count(*)::int` })
    .from(assistantMessages)
    .where(
      and(
        eq(assistantMessages.ownerId, ownerId),
        eq(assistantMessages.direction, 'outbound'),
        gt(assistantMessages.createdAt, since),
        inArray(
          assistantMessages.agentId,
          candidates.map((c) => c.id),
        ),
      ),
    )
    .groupBy(assistantMessages.agentId);

  // `agentId` is nullable in the schema, but the inArray filter above
  // excludes null rows — drop them so the Map key type narrows to string.
  const activity = new Map(
    counts.flatMap((c) => (c.agentId == null ? [] : [[c.agentId, c.n] as const])),
  );
  return rankActiveAgents(candidates, activity);
}

type ReflectorOutput = {
  new_notes: Array<{
    kind: 'style' | 'relationship' | 'correction';
    content: string;
  }>;
};

function parseReflectorOutput(raw: string): ReflectorOutput {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try {
    const parsed = JSON.parse(cleaned) as ReflectorOutput;
    if (!Array.isArray(parsed.new_notes)) return { new_notes: [] };
    return {
      new_notes: parsed.new_notes
        .filter(
          (n) =>
            n &&
            typeof n.content === 'string' &&
            n.content.trim().length > 0 &&
            ['style', 'relationship', 'correction'].includes(n.kind),
        )
        .slice(0, 10), // hard cap per run
    };
  } catch {
    return { new_notes: [] };
  }
}

export async function reflect(ownerId: string): Promise<void> {
  // Reflector runs on a 10-min interval; tracing every skip here is
  // cheap (max 144 rows/day per skip-reason). Every early-return
  // path records a 'skipped' trace so the operator can see why the
  // reflector hasn't been touching their persona notes.
  const reflector = await resolveReflector(ownerId);
  if (!reflector) {
    await recordSkippedTrace({
      kind: 'reflector_run',
      ownerId,
      subjectKind: 'agent_tick',
      disposition: 'no_reflector_worker',
      details: { hint: 'Set a default reflector at /settings/ai-workers.' },
    });
    return;
  }
  // Key pre-flight via the shared resolver — keyless `local` passes; a
  // misconfigured cloud worker skips with the matching disposition.
  const keyCheck = await resolveChatKey(ownerId, reflector);
  if (!keyCheck.ok) {
    console.error(`[reflector] worker '${reflector.slug}' ${keyCheck.detail} — skipping`);
    await recordSkippedTrace({
      kind: 'reflector_run',
      ownerId,
      subjectKind: 'agent_tick',
      disposition: keyCheck.disposition,
      details: { worker_slug: reflector.slug, api_key_id: reflector.apiKeyId },
    });
    return;
  }

  // Which conversational agents have new activity since the last run? This is
  // the role-decoupled replacement for "the single responder": any agent the
  // user actually conversed with, bounded by activity (cost-safety §2).
  const since = reflector.lastUsedAt ?? new Date(0);
  const qualifying = await qualifyingAgents(ownerId, since);
  if (qualifying.length === 0) {
    await recordSkippedTrace({
      kind: 'reflector_run',
      ownerId,
      subjectKind: 'agent_tick',
      disposition: 'no_new_activity',
      details: { worker_slug: reflector.slug, since: since.toISOString() },
    });
    return;
  }

  const batch = qualifying.slice(0, MAX_AGENTS_PER_RUN);
  if (qualifying.length > batch.length) {
    console.warn(
      `[reflector] ${qualifying.length} agents with new activity; reflecting the ${batch.length} most active this tick (cap MAX_AGENTS_PER_RUN=${MAX_AGENTS_PER_RUN}) — the rest catch up next tick.`,
    );
  }

  for (const agent of batch) {
    try {
      await reflectOnAgent(ownerId, reflector, agent, since);
    } catch (err) {
      console.error(
        `[reflector] agent '${agent.slug}' failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Advance the watermark ONCE after the batch so the next run only sees turns
  // newer than this pass — even agents that yielded no fresh notes are covered
  // (their activity was reviewed). A per-agent bump would let an erroring agent
  // re-pull the same turns forever.
  await bumpWorkerUsage(reflector.id);
}

/** Reflect over a single agent's recent transcript and append any fresh
 *  persona notes to ITS `persona_notes`. One trace per agent. */
async function reflectOnAgent(
  ownerId: string,
  reflector: AiWorker,
  agent: Agent,
  since: Date,
): Promise<void> {
  await startTrace(
    {
      kind: 'reflector_run',
      ownerId,
      subjectKind: 'agent_tick',
      // The trace's agentId is the agent whose persona_notes we're editing.
      agentId: agent.id,
      data: {
        worker_slug: reflector.slug,
        worker_id: reflector.id,
        targetAgentId: agent.id,
        targetAgentSlug: agent.slug,
        newOutboundSince: since.toISOString(),
      },
    },
    async () => {
      // The agent's own per-(owner, agent) transcript — every surface it
      // converses on (web + Telegram + future channels) lands in
      // assistant_messages, so one query covers them all.
      const turns = await step(
        { name: 'load_recent_turns', kind: 'db_read', input: { limit: REFLECTION_WINDOW } },
        async (h) => {
          const rows = await db
            .select({
              direction: assistantMessages.direction,
              text: assistantMessages.text,
              sentAt: assistantMessages.createdAt,
            })
            .from(assistantMessages)
            .where(
              and(eq(assistantMessages.ownerId, ownerId), eq(assistantMessages.agentId, agent.id)),
            )
            .orderBy(desc(assistantMessages.createdAt))
            .limit(REFLECTION_WINDOW);
          h.setOutput({ count: rows.length });
          return rows;
        },
      );
      if (turns.length === 0) return;

      // Render chronologically (oldest first).
      const transcript = turns
        .slice()
        .reverse()
        .map((t) => {
          const who = t.direction === 'outbound' ? 'assistant' : 'user';
          return `[${t.sentAt.toISOString()}] ${who}: ${t.text}`;
        })
        .join('\n');

      const existingNotes = (agent.personaNotes ?? []) as PersonaNote[];
      // Dedup against ACTIVE notes only — a note the user explicitly
      // retired via update_persona shouldn't read as "already covered"
      // (which would stop the reflector re-learning) nor be shown back
      // to the model as current guidance.
      const liveNotes = activeNotes(existingNotes);
      const existingNotesText =
        liveNotes.length === 0
          ? '(no existing notes)'
          : liveNotes.map((n) => `- (${n.kind}) ${n.content}`).join('\n');

      const userPayload = `Existing persona_notes:\n${existingNotesText}\n\nRecent transcript (${turns.length} turns):\n${transcript}`;

      const params = (reflector.params ?? {}) as ReflectorParams;
      const routes = resolveChatRoutes(reflector);

      console.log(
        `[reflector] ${agent.slug}: reviewing ${turns.length} turns (since ${since.toISOString()}) via ${routes.primary.provider}:${routes.primary.model}` +
          (routes.backup ? ` (backup ${routes.backup.provider}:${routes.backup.model})` : ''),
      );

      const result = await step(
        {
          name: 'llm_reflect',
          kind: 'llm_call',
          input: { model: reflector.model, provider: reflector.provider },
        },
        async (h) => {
          const { result, failedOver, usedProvider } = await chatWithFailover(
            ownerId,
            routes,
            {
              messages: [
                {
                  role: 'system',
                  content: reflector.systemPrompt || DEFAULT_REFLECTOR_PROMPT,
                },
                { role: 'user', content: userPayload },
              ],
              // The reflector fires on a ~10-minute timer; Anthropic's
              // cache TTL is 5min so most fires MISS cache and pay the
              // 1.25× cache-write penalty without immediate benefit.
              // Net-net close to break-even (back-to-back fires within
              // 5min hit), and consistency with the other chat-shaped
              // workers beats a clever skip.
              cacheControl: { systemPrompt: true },
              ...(typeof params.temperature === 'number'
                ? { temperature: params.temperature }
                : {}),
              ...(typeof params.max_tokens === 'number' ? { maxTokens: params.max_tokens } : {}),
              ...(typeof params.top_p === 'number' ? { topP: params.top_p } : {}),
            },
            (m) => console.warn(`[reflector] ${m}`),
          );
          if (failedOver) console.warn(`[reflector] reflected via backup route (${usedProvider})`);
          recordChatUsage(h, result, result.model || routes.primary.model);
          return result;
        },
      );

      const parsed = parseReflectorOutput(result.text);

      // Backstop dedup: the prompt asks for only-new signals, but the reflector
      // still re-learns the same trait worded differently across runs. Drop notes
      // that substantially duplicate an existing active note before they bloat
      // persona_notes (and push capNotes into evicting a distinct one).
      const freshNotes = dedupeNewNotes(existingNotes, parsed.new_notes);

      if (freshNotes.length === 0) {
        console.log(
          `[reflector]   → ${agent.slug}: nothing new (${parsed.new_notes.length} candidate(s) were duplicates)`,
        );
        return;
      }

      const now = new Date().toISOString();
      const appended: PersonaNote[] = freshNotes.map((n) => ({
        // Stamp an id so the note is addressable by update_persona later
        // (e.g. the user asks to drop a preference the reflector learned).
        id: randomUUID(),
        kind: n.kind,
        content: n.content.trim(),
        at: now,
      }));

      // Append + cap. capNotes never evicts an active note — it drops the
      // oldest retired (audit-tail) notes first when over budget.
      const merged = capNotes([...existingNotes, ...appended], MAX_PERSONA_NOTES);

      await step(
        { name: 'append_notes', kind: 'db_write', input: { count: appended.length } },
        async (h) => {
          await db
            .update(agents)
            .set({ personaNotes: merged, updatedAt: new Date() })
            .where(eq(agents.id, agent.id));
          h.setMeta({ totalNotesAfter: merged.length });
        },
      );

      console.log(
        `[reflector]   → ${agent.slug}: appended ${appended.length} note(s): ${appended.map((n) => n.kind).join(', ')}`,
      );
    },
  );
}
