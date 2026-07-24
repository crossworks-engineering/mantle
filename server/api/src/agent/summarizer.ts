/**
 * Tier-2 conversation memory.
 *
 * `summarizeAgentConversation(ownerId, agentId)` looks at the oldest undigested
 * turns of ONE per-(owner, agent) conversation stream (`assistant_messages`,
 * across ALL channels — web, Telegram, …) and rolls them into `note` nodes
 * tagged `conversation-digest` + keyed by `data.agent_id`. The responder reads
 * these back (loadConversationContext) so older context survives past the
 * raw-history window. See docs/conversation.md.
 *
 * Driven from a debounced LISTEN on `summarize_due` (payload = agent id, since
 * migration 0072) in main.ts. This module is intentionally pure-logic — no
 * listeners, no LISTEN handling.
 */

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  db,
  agents,
  assistantMessages,
  bumpWorkerUsage,
  getDefaultWorker,
  nodes,
  type AiWorker,
  type SummarizerParams,
} from '@mantle/db';
import { recordSkippedTrace, startTrace, step } from '@mantle/tracing';
import { digestEmbedText, embedBatch } from '@mantle/embeddings';
import {
  buildChatMessages,
  chatWithFailover,
  flattenChatMessagesForAdapter,
  recordChatUsage,
  resolveChatKey,
  resolveChatRoutes,
} from '@mantle/agent-runtime';

/** Default seeded into the UI when role flips to `summarizer`. The user can
 *  edit it on the agent row at any time. */
export const DEFAULT_SUMMARIZER_PROMPT = `You are a memory compressor for an ongoing Telegram conversation. You will be given a chronological transcript of a chat between the user and an AI assistant, with each line prefixed by its 1-indexed turn number.

Group the transcript into TOPICS — contiguous stretches of turns about a single subject. A short batch is often one topic; a longer batch may contain several. Don't force splits.

For each topic, produce:
  - A short label (2-5 words, title case, e.g. "Lister Gantry Rebuild", "Sunday Sermon Prep")
  - A factual summary (3-6 sentences, no headers, no bullet lists) capturing decisions, commitments, specific facts about people/places/dates/numbers, and notable shifts in tone
  - The turn numbers belonging to this topic (contiguous range; topics don't overlap)

Be specific — write "Maria is presenting the Q3 report on Thursday" not "they discussed work plans." Use names when known. Skip conversational filler.

Output STRICT JSON, no markdown fences, no commentary outside the JSON:

{
  "topics": [
    {
      "label": "<2-5 words>",
      "summary": "<3-6 sentences>",
      "turn_indexes": [<int>, <int>, ...]
    }
  ]
}

The turn_indexes array must contain every turn number from the transcript exactly once across all topics combined.`;

async function resolveSummarizer(ownerId: string): Promise<AiWorker | null> {
  return await getDefaultWorker(ownerId, 'summarizer');
}

/** ltree path conversation digests hang under. The unified per-(owner, agent)
 *  stream isn't chat-scoped, so digests live under a fixed cosmetic label —
 *  find_window/responder match by the `conversation-digest` tag + the digest
 *  note's data.agent_id + embedding, not by path. */
const CONVERSATION_DIGEST_PATH = 'assistant';

/**
 * Unified summarizer — rolls the oldest undigested turns of ONE per-(owner,
 * agent) conversation stream (assistant_messages, ALL channels) into
 * `conversation-digest` notes keyed by the note's data.agent_id, so
 * find_window + the responder's Tier-2 memory index every channel's turns in
 * one place. Replaces the old per-chat (summarizeChat) + per-owner-web
 * (summarizeWebConversation) split. Driven from the debounced summarize handler
 * in main.ts.
 */
export async function summarizeAgentConversation(ownerId: string, agentId: string): Promise<void> {
  const worker = await resolveSummarizer(ownerId);
  if (!worker) {
    await recordSkippedTrace({
      kind: 'summarizer_run',
      ownerId,
      subjectId: agentId,
      subjectKind: 'agent_conversation',
      disposition: 'no_summarizer_worker',
      details: { agent_id: agentId, hint: 'Set a default summarizer at /settings/ai-workers.' },
    });
    return;
  }
  // Key pre-flight via the shared resolver (keyless `local` passes).
  const keyCheck = await resolveChatKey(ownerId, worker);
  if (!keyCheck.ok) {
    await recordSkippedTrace({
      kind: 'summarizer_run',
      ownerId,
      subjectId: agentId,
      subjectKind: 'agent_conversation',
      disposition: keyCheck.disposition,
      details: { worker_slug: worker.slug, agent_id: agentId },
    });
    return;
  }

  const params = (worker.params ?? {}) as SummarizerParams;
  const threshold = params.summarize_threshold ?? 30;
  const batchSize = params.summarize_batch ?? params.window_size ?? 20;

  // Count undigested turns for THIS agent's stream only.
  const countRows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(assistantMessages)
    .where(
      and(
        eq(assistantMessages.ownerId, ownerId),
        eq(assistantMessages.agentId, agentId),
        isNull(assistantMessages.digestNodeId),
      ),
    );
  const undigested = countRows[0]?.n ?? 0;
  if (undigested < threshold) return;

  // Resolve the conversational agent's slug for digest provenance + tags.
  const [agentRow] = await db
    .select({ slug: agents.slug })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  const agentSlug = agentRow?.slug ?? agentId;

  await startTrace(
    {
      kind: 'summarizer_run',
      ownerId,
      subjectId: agentId,
      subjectKind: 'agent_conversation',
      data: {
        worker_slug: worker.slug,
        agent_id: agentId,
        agent_slug: agentSlug,
        threshold,
        batchSize,
        undigestedAtStart: undigested,
      },
    },
    async () => {
      const batch = await step(
        { name: 'load_batch', kind: 'db_read', input: { batchSize } },
        async (h) => {
          const rows = await db
            .select({
              id: assistantMessages.id,
              direction: assistantMessages.direction,
              text: assistantMessages.text,
              createdAt: assistantMessages.createdAt,
            })
            .from(assistantMessages)
            .where(
              and(
                eq(assistantMessages.ownerId, ownerId),
                eq(assistantMessages.agentId, agentId),
                isNull(assistantMessages.digestNodeId),
              ),
            )
            .orderBy(asc(assistantMessages.createdAt))
            .limit(batchSize);
          h.setOutput({ count: rows.length });
          return rows;
        },
      );
      if (batch.length === 0) return;

      const transcript = batch
        .map((t, i) => {
          const who = t.direction === 'outbound' ? 'assistant' : 'user';
          return `#${i + 1} [${t.createdAt.toISOString()}] ${who}: ${t.text}`;
        })
        .join('\n');

      const messages = buildChatMessages({
        model: worker.model,
        provider: worker.provider,
        systemPrompt: worker.systemPrompt ?? DEFAULT_SUMMARIZER_PROMPT,
        personaNotes: [],
        facts: [],
        digests: [],
        contentHits: [],
        history: [],
        newUserText: transcript,
      });

      const routes = resolveChatRoutes(worker);
      console.log(
        `[agent] summarizing ${agentSlug} conversation (${batch.length} turns, ${routes.primary.provider}:${routes.primary.model}` +
          (routes.backup ? ` · backup ${routes.backup.provider}:${routes.backup.model}` : '') +
          ')',
      );

      const result = await step(
        {
          name: 'llm_summarize',
          kind: 'llm_call',
          input: { model: worker.model, provider: worker.provider },
        },
        async (h) => {
          const {
            result: r,
            failedOver,
            usedProvider,
          } = await chatWithFailover(
            ownerId,
            routes,
            {
              messages: flattenChatMessagesForAdapter(messages),
              // Same rationale as the Telegram summariser: system prompt
              // is stable per worker, mark it cacheable.
              cacheControl: { systemPrompt: true },
              ...(typeof params.temperature === 'number'
                ? { temperature: params.temperature }
                : {}),
              ...(typeof params.max_tokens === 'number' ? { maxTokens: params.max_tokens } : {}),
              ...(typeof params.top_p === 'number' ? { topP: params.top_p } : {}),
            },
            (m) => console.warn(`[summarizer] ${m}`),
          );
          if (failedOver)
            console.warn(`[summarizer] summarized via backup route (${usedProvider})`);
          recordChatUsage(h, r, r.model || routes.primary.model);
          return r;
        },
      );

      const rawText = result.text.trim();
      if (!rawText) throw new Error('summarizer: empty response — not persisting');

      const topics = parseTopics(rawText, batch.length);
      if (topics.length === 0) throw new Error('summarizer: no usable topics — not persisting');

      // Embed each topic (label + summary) so find_window can cosine-rank
      // digests — without this, digests are invisible to Remy's routing
      // search, which filters on `embedding IS NOT NULL`. Best-effort and
      // BEFORE the transaction (network call): an embedder outage must not
      // lose the digest. NULL embeddings are healed by
      // `pnpm -C server/web backfill:digest-embeddings`.
      let topicVecs: (number[] | null)[] = topics.map(() => null);
      try {
        topicVecs = await step(
          { name: 'embed_digests', kind: 'compute', input: { count: topics.length } },
          async (h) => {
            const vecs = await embedBatch(
              ownerId,
              topics.map((t) => digestEmbedText(t.label, t.summary)),
            );
            h.setOutput({ embedded: vecs.length });
            return vecs;
          },
        );
      } catch (err) {
        console.warn(
          '[summarizer] digest embed failed — inserting without embeddings ' +
            `(run backfill:digest-embeddings to heal): ${err instanceof Error ? err.message : err}`,
        );
      }

      // Persist digests + mark turns in ONE transaction, claiming the batch
      // first. The claim (SELECT … FOR UPDATE on still-undigested rows) makes
      // a concurrent run for the same agent — the 2s debounce can't cover a
      // 10-60s LLM call — abort cleanly instead of double-digesting the same
      // turns; the single transaction means a crash can't leave digests
      // inserted but turns unmarked (the orphan-then-redigest failure).
      const inserted = await step(
        {
          name: 'persist_digests',
          kind: 'db_write',
          input: { topics: topics.length, turns: batch.length },
        },
        async (h) => {
          return await db.transaction(async (tx) => {
            const batchIds = batch.map((b) => b.id);
            const still = await tx
              .select({ id: assistantMessages.id })
              .from(assistantMessages)
              .where(
                and(
                  eq(assistantMessages.ownerId, ownerId),
                  inArray(assistantMessages.id, batchIds),
                  isNull(assistantMessages.digestNodeId),
                ),
              )
              .for('update');
            if (still.length !== batchIds.length) {
              h.setMeta({
                disposition: 'lost_claim_race',
                still_undigested: still.length,
                expected: batchIds.length,
              });
              return null;
            }

            const turnToDigest = new Map<string, string>();
            const out: { topic: string; turnCount: number }[] = [];
            for (let ti = 0; ti < topics.length; ti++) {
              const topic = topics[ti]!;
              const turns = topic.turnIndexes
                .map((i) => batch[i - 1])
                .filter((t): t is (typeof batch)[number] => t != null);
              if (turns.length === 0) continue;
              const periodStart = turns[0]!.createdAt.toISOString();
              const periodEnd = turns[turns.length - 1]!.createdAt.toISOString();
              const title = `${topic.label} · ${periodStart.slice(0, 10)} → ${periodEnd.slice(0, 10)} (${turns.length} turns)`;

              const vec = topicVecs[ti] ?? null;
              const [n] = await tx
                .insert(nodes)
                .values({
                  ownerId,
                  type: 'note',
                  title,
                  path: CONVERSATION_DIGEST_PATH,
                  ...(vec ? { embedding: vec } : {}),
                  data: {
                    kind: 'conversation_digest',
                    // The conversational agent this digest belongs to — the key
                    // loadConversationContext filters digests by (per agent,
                    // cross-channel). NOT the summarizer worker.
                    agent_id: agentId,
                    agent_slug: agentSlug,
                    period_start: periodStart,
                    period_end: periodEnd,
                    source_turn_count: turns.length,
                    model: worker.model,
                    summarizer_worker: worker.slug,
                    content: topic.summary,
                    summary: topic.summary,
                    topic: topic.label,
                    topic_slug: slugifyTopic(topic.label),
                  },
                  tags: [
                    'conversation-digest',
                    `agent:${slugifyTopic(agentSlug)}`,
                    `topic:${slugifyTopic(topic.label)}`,
                  ],
                })
                .returning({ id: nodes.id });
              if (!n) throw new Error('summarizer: failed to insert digest node');
              for (const t of turns) turnToDigest.set(t.id, n.id);
              out.push({ topic: topic.label, turnCount: turns.length });
            }

            // Topics parsed but none resolved to actual turns (model emitted
            // empty/garbled turn_indexes everywhere): throwing rolls back and
            // surfaces an errored trace. Silently returning here would leave
            // the batch undigested and re-bill the same LLM call on every
            // subsequent insert — an unbounded spend leak.
            if (out.length === 0) {
              throw new Error(
                'summarizer: topics parsed but none resolved to turns — not persisting',
              );
            }

            const fallbackId = turnToDigest.values().next().value;
            if (fallbackId) {
              for (const t of batch)
                if (!turnToDigest.has(t.id)) turnToDigest.set(t.id, fallbackId);
            }

            const byDigest = new Map<string, string[]>();
            for (const [turnId, digestId] of turnToDigest) {
              const list = byDigest.get(digestId) ?? [];
              list.push(turnId);
              byDigest.set(digestId, list);
            }
            for (const [digestId, ids] of byDigest) {
              await tx
                .update(assistantMessages)
                .set({ digestNodeId: digestId })
                .where(inArray(assistantMessages.id, ids));
            }
            h.setMeta({ digests: out.length, embedded: topicVecs.filter(Boolean).length });
            return out;
          });
        },
      );
      if (!inserted) {
        console.warn(
          `[agent] summarize for ${agentSlug} skipped — batch claimed by a concurrent run`,
        );
        return;
      }

      void bumpWorkerUsage(worker.id);
      console.log(
        `[agent] ✓ ${inserted.length} digest(s) for ${agentSlug}: ` +
          inserted.map((d) => `"${d.topic}" (${d.turnCount}t)`).join(', '),
      );
    },
  );
}

type ParsedTopic = {
  label: string;
  summary: string;
  turnIndexes: number[];
};

/**
 * Parse the summarizer's JSON output. Accepts both the new
 * `{ topics: [...] }` shape and the legacy single-summary string for
 * backward compatibility — a string response is treated as one topic
 * covering all turns, labelled "General".
 */
function parseTopics(raw: string, batchSize: number): ParsedTopic[] {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  // Plain-text fallback (legacy / model didn't comply with JSON).
  if (!cleaned.startsWith('{')) {
    return [
      {
        label: 'General',
        summary: cleaned,
        turnIndexes: Array.from({ length: batchSize }, (_, i) => i + 1),
      },
    ];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [
      {
        label: 'General',
        summary: cleaned,
        turnIndexes: Array.from({ length: batchSize }, (_, i) => i + 1),
      },
    ];
  }

  const obj = parsed as { topics?: unknown };
  if (!Array.isArray(obj.topics)) return [];

  const out: ParsedTopic[] = [];
  for (const t of obj.topics) {
    if (!t || typeof t !== 'object') continue;
    const o = t as Record<string, unknown>;
    const label = typeof o.label === 'string' ? o.label.trim() : '';
    const summary = typeof o.summary === 'string' ? o.summary.trim() : '';
    if (!label || !summary) continue;
    const idxs = Array.isArray(o.turn_indexes)
      ? o.turn_indexes
          .map((v) => Number(v))
          .filter((v) => Number.isInteger(v) && v >= 1 && v <= batchSize)
          .sort((a, b) => a - b)
      : [];
    out.push({ label, summary, turnIndexes: idxs });
  }
  return out;
}

/** Lowercase + dash slug, capped at 64 chars. Used in node.tags so a
 *  `topic:lister-gantry-rebuild` tag can be `@>` matched at query time. */
function slugifyTopic(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}
