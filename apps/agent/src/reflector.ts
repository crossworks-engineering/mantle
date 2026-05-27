/**
 * Reflector — Stage-E agent. Slow background pass that watches recent
 * dialog for relationship signals (style preferences, corrections, in-
 * jokes) and appends them to the responder's `persona_notes`.
 *
 * Not triggered per-turn — runs on a timer (default every 10 minutes) and
 * short-circuits if there's been no new outbound activity since the last
 * run. Decoupling from the reply path matters: reflection is a slow,
 * possibly-expensive read across many turns, and we don't want it on the
 * critical path for the user's next message.
 *
 * Operates on the SAME responder agent's persona_notes column — the
 * reflector doesn't have its own notes. Resolves the highest-priority
 * enabled responder for the owner and appends to that row.
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import {
  db,
  agents,
  activeNotes,
  assistantMessages,
  bumpWorkerUsage,
  capNotes,
  getDefaultWorker,
  MAX_PERSONA_NOTES,
  telegramMessages,
  type Agent,
  type AiWorker,
  type PersonaNote,
  type ReflectorParams,
} from '@mantle/db';
import { getApiKeyById } from '@mantle/api-keys';
import { recordSkippedTrace, startTrace, step } from '@mantle/tracing';
import { recordChatUsage } from '@mantle/agent-runtime';
import { getChatAdapter } from '@mantle/voice';

/** How many recent turns the reflector reviews per run. */
const REFLECTION_WINDOW = 50;

export const DEFAULT_REFLECTOR_PROMPT = `You are a reflector for a personal AI assistant. You will be given a transcript of recent exchanges between the user and the assistant, plus the assistant's current persona_notes (preferences, relationship notes, corrections already learned).

Your job: spot NEW signals worth remembering, AND ONLY new ones.

Look for:
  • style hints       — how the user wants to be addressed, response format preferences ("be terse", "skip bullet lists")
  • relationship notes — facts about how the user and the assistant interact ("Jason calls me 'S' for short", "the user uses dry humour")
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
- Be specific — "Jason prefers terse, no-bullet replies" beats "user likes brevity".
- Don't invent — only return notes grounded in the transcript.
- Return an EMPTY new_notes array if nothing notable surfaces.
- Don't include trivia about content (those belong in facts, not persona).`;

/** Find this owner's reflector worker (kind='reflector'). Returns
 *  null if none is configured — `reflect()` short-circuits cleanly. */
async function resolveReflector(ownerId: string): Promise<AiWorker | null> {
  return await getDefaultWorker(ownerId, 'reflector');
}

async function resolveResponderAgent(ownerId: string): Promise<Agent | null> {
  const [row] = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.ownerId, ownerId),
        eq(agents.role, 'responder'),
        eq(agents.enabled, true),
      ),
    )
    .orderBy(desc(agents.priority))
    .limit(1);
  return row ?? null;
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
  if (!reflector.apiKeyId) {
    console.error(`[reflector] worker '${reflector.slug}' has no api_key_id — skipping`);
    await recordSkippedTrace({
      kind: 'reflector_run',
      ownerId,
      subjectKind: 'agent_tick',
      disposition: 'no_api_key_id',
      details: { worker_slug: reflector.slug },
    });
    return;
  }

  const responder = await resolveResponderAgent(ownerId);
  if (!responder) {
    console.error('[reflector] no enabled responder agent — nowhere to append notes');
    await recordSkippedTrace({
      kind: 'reflector_run',
      ownerId,
      subjectKind: 'agent_tick',
      disposition: 'no_responder_agent',
      details: {
        worker_slug: reflector.slug,
        hint: 'Reflector edits persona_notes on the responder; create an enabled responder agent first.',
      },
    });
    return;
  }

  // Short-circuit if nothing new since the last reflector run. Cheap
  // COUNT across BOTH surfaces — Telegram and web /assistant. Persona
  // is one column on the responder; both surfaces should contribute.
  const since = reflector.lastUsedAt ?? new Date(0);
  const [tgCount, webCount] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(telegramMessages)
      .where(
        and(eq(telegramMessages.direction, 'outbound'), gt(telegramMessages.sentAt, since)),
      ),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(assistantMessages)
      .where(
        and(
          eq(assistantMessages.ownerId, ownerId),
          eq(assistantMessages.direction, 'outbound'),
          gt(assistantMessages.createdAt, since),
        ),
      ),
  ]);
  const newCount = (tgCount[0]?.n ?? 0) + (webCount[0]?.n ?? 0);
  if (newCount === 0) {
    await recordSkippedTrace({
      kind: 'reflector_run',
      ownerId,
      subjectKind: 'agent_tick',
      disposition: 'no_new_activity',
      details: {
        worker_slug: reflector.slug,
        since: since.toISOString(),
        telegram_outbound: tgCount[0]?.n ?? 0,
        web_outbound: webCount[0]?.n ?? 0,
      },
    });
    return;
  }

  const apiKey = await getApiKeyById(reflector.apiKeyId);
  if (!apiKey) {
    console.error(`[reflector] api_key_id ${reflector.apiKeyId} not found — skipping`);
    await recordSkippedTrace({
      kind: 'reflector_run',
      ownerId,
      subjectKind: 'agent_tick',
      disposition: 'api_key_not_decryptable',
      details: { worker_slug: reflector.slug, api_key_id: reflector.apiKeyId },
    });
    return;
  }

  await startTrace(
    {
      kind: 'reflector_run',
      ownerId,
      subjectKind: 'agent_tick',
      // The trace's agentId historically pointed at the responder
      // (whose persona_notes we're editing). Keep that — the reflector
      // worker's own id is referenced via subject below.
      agentId: responder.id,
      data: {
        worker_slug: reflector.slug,
        worker_id: reflector.id,
        responderAgentId: responder.id,
        newOutboundSince: since.toISOString(),
      },
    },
    async () => {
      // Union Telegram + web /assistant turns so persona learning sees
      // every surface the user converses on. Each query independently
      // pulls REFLECTION_WINDOW rows; we merge by timestamp and keep
      // the most recent REFLECTION_WINDOW overall.
      const turns = await step(
        { name: 'load_recent_turns', kind: 'db_read', input: { limit: REFLECTION_WINDOW } },
        async (h) => {
          const [tgRows, webRows] = await Promise.all([
            db
              .select({
                direction: telegramMessages.direction,
                text: telegramMessages.text,
                sentAt: telegramMessages.sentAt,
                fromName: telegramMessages.fromName,
              })
              .from(telegramMessages)
              .orderBy(desc(telegramMessages.sentAt))
              .limit(REFLECTION_WINDOW),
            db
              .select({
                direction: assistantMessages.direction,
                text: assistantMessages.text,
                sentAt: assistantMessages.createdAt,
                fromName: sql<string | null>`null`.as('fromName'),
              })
              .from(assistantMessages)
              .where(eq(assistantMessages.ownerId, ownerId))
              .orderBy(desc(assistantMessages.createdAt))
              .limit(REFLECTION_WINDOW),
          ]);
          const merged = [...tgRows, ...webRows]
            .sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime())
            .slice(0, REFLECTION_WINDOW);
          h.setOutput({ count: merged.length, telegram: tgRows.length, web: webRows.length });
          return merged;
        },
      );
      if (turns.length === 0) return;

      // Render chronologically (oldest first). `fromName` is Telegram-only;
      // web turns use a generic 'user' label.
      const transcript = turns
        .slice()
        .reverse()
        .map((t) => {
          const who = t.direction === 'outbound' ? 'assistant' : (t.fromName ?? 'user');
          return `[${t.sentAt.toISOString()}] ${who}: ${t.text}`;
        })
        .join('\n');

      const existingNotes = (responder.personaNotes ?? []) as PersonaNote[];
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
      const adapter = getChatAdapter(reflector.provider);
      if (!adapter) {
        throw new Error(
          `reflector: no chat adapter registered for provider '${reflector.provider}'. ` +
            `Register one in packages/voice/src/adapters/index.ts, or switch the worker.`,
        );
      }

      console.log(
        `[reflector] reviewing ${turns.length} turns (since ${since.toISOString()}) via ${adapter.adapterName}:${reflector.model}`,
      );

      const result = await step(
        {
          name: 'llm_reflect',
          kind: 'llm_call',
          input: { model: reflector.model, provider: reflector.provider },
        },
        async (h) => {
          const r = await adapter.chat({
            apiKey,
            model: reflector.model,
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
            ...(typeof params.max_tokens === 'number'
              ? { maxTokens: params.max_tokens }
              : {}),
            ...(typeof params.top_p === 'number' ? { topP: params.top_p } : {}),
          });
          recordChatUsage(h, r, reflector.model);
          return r;
        },
      );

      const parsed = parseReflectorOutput(result.text);

      if (parsed.new_notes.length === 0) {
        console.log('[reflector]   → nothing new');
        // Still bump last_used_at so we don't reprocess the same turns next tick.
        void bumpWorkerUsage(reflector.id);
        return;
      }

      const now = new Date().toISOString();
      const appended: PersonaNote[] = parsed.new_notes.map((n) => ({
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
            .where(eq(agents.id, responder.id));
          h.setMeta({ totalNotesAfter: merged.length });
        },
      );

      await bumpWorkerUsage(reflector.id);

      console.log(
        `[reflector]   → appended ${appended.length} note(s): ${appended.map((n) => `${n.kind}`).join(', ')}`,
      );
    },
  );
}
