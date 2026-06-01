/**
 * Tier-2 conversation memory.
 *
 * `summarizeChat(chatPk, ownerId)` looks at the oldest undigested
 * telegram_messages rows in a chat and rolls them into a single `note` node
 * tagged `conversation-digest`. The responder agent reads these back as part
 * of its prompt-building so older context survives past the raw-history
 * window.
 *
 * Driven from a debounced LISTEN on `summarize_due` in main.ts. This module
 * is intentionally pure-logic — no listeners, no LISTEN handling.
 */

import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  db,
  agents,
  assistantMessages,
  bumpWorkerUsage,
  getDefaultWorker,
  nodes,
  telegramMessages,
  telegramAccounts,
  telegramChats,
  type AiWorker,
  type SummarizerParams,
} from '@mantle/db';
import { recordSkippedTrace, startTrace, step } from '@mantle/tracing';
import {
  buildChatMessages,
  chatWithFailover,
  flattenChatMessagesForAdapter,
  recordChatUsage,
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

Be specific — write "Jason is preaching on Romans 8 this Sunday" not "they discussed church plans." Use names when known. Skip conversational filler.

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

export async function summarizeChat(chatPk: string, ownerId: string): Promise<void> {
  // Skip-tracing policy for summarizer:
  //   - Configuration-level skips (no worker / no api key) ARE traced
  //     because they're rare-but-actionable: the operator wants to
  //     see "summarizer never runs because you forgot to set it up."
  //   - The threshold check (undigested < N) is NOT traced because
  //     it fires on every inbound Telegram message and would flood
  //     the traces table. The signal "summarizer did roll something
  //     up" is already captured by the success trace below; the
  //     absence of a recent successful trace on a chat tells the
  //     same story without per-message noise.
  const worker = await resolveSummarizer(ownerId);
  if (!worker) {
    await recordSkippedTrace({
      kind: 'summarizer_run',
      ownerId,
      subjectId: chatPk,
      subjectKind: 'chat',
      disposition: 'no_summarizer_worker',
      details: { hint: 'Set a default summarizer at /settings/ai-workers.' },
    });
    return;
  }
  // Key pre-flight for CLOUD workers only — `local` is keyless. The chat call
  // resolves its own key via resolveRouteAdapter (incl. local-keyless), so a
  // local-primary summarizer must not be skipped here. See extractor.ts.
  if (worker.provider !== 'local' && !worker.apiKeyId) {
    console.error(`[agent] summarizer '${worker.slug}' has no api_key_id — skipping`);
    await recordSkippedTrace({
      kind: 'summarizer_run',
      ownerId,
      subjectId: chatPk,
      subjectKind: 'chat',
      disposition: 'no_api_key_id',
      details: { worker_slug: worker.slug },
    });
    return;
  }

  const params = (worker.params ?? {}) as SummarizerParams;
  const threshold = params.summarize_threshold ?? 30;
  const batchSize = params.summarize_batch ?? params.window_size ?? 20;

  // Cheap short-circuit: count undigested turns. Uses the partial index
  // telegram_messages_chat_undigested_idx so this stays O(log n).
  // Done OUTSIDE the trace so we don't generate a row for every notify on
  // chats that aren't ready to roll up — that's the common case.
  const countRows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(telegramMessages)
    .where(and(eq(telegramMessages.chatId, chatPk), isNull(telegramMessages.digestNodeId)));
  const undigested = countRows[0]?.n ?? 0;
  if (undigested < threshold) return;

  await startTrace(
    {
      kind: 'summarizer_run',
      ownerId,
      subjectId: chatPk,
      subjectKind: 'chat',
      data: { worker_slug: worker.slug, threshold, batchSize, undigestedAtStart: undigested },
    },
    async () => {
      // Pick the oldest `batchSize` undigested turns.
      const batch = await step(
        { name: 'load_batch', kind: 'db_read', input: { batchSize } },
        async (h) => {
          const rows = await db
            .select({
              id: telegramMessages.id,
              direction: telegramMessages.direction,
              text: telegramMessages.text,
              sentAt: telegramMessages.sentAt,
              fromName: telegramMessages.fromName,
            })
            .from(telegramMessages)
            .where(
              and(
                eq(telegramMessages.chatId, chatPk),
                isNull(telegramMessages.digestNodeId),
              ),
            )
            .orderBy(asc(telegramMessages.sentAt))
            .limit(batchSize);
          h.setOutput({ count: rows.length });
          return rows;
        },
      );

      if (batch.length === 0) return;

      const { account, chatRow } = await step(
        { name: 'load_chat_account', kind: 'db_read' },
        async () => {
          const [chat] = await db
            .select({
              accountId: telegramChats.accountId,
              telegramChatId: telegramChats.telegramChatId,
            })
            .from(telegramChats)
            .where(eq(telegramChats.id, chatPk))
            .limit(1);
          if (!chat) {
            throw new Error(`summarizer: chat ${chatPk} not found`);
          }
          const [acc] = await db
            .select({ branchPath: telegramAccounts.branchPath })
            .from(telegramAccounts)
            .where(eq(telegramAccounts.id, chat.accountId))
            .limit(1);
          if (!acc) {
            throw new Error(`summarizer: account for chat ${chatPk} not found`);
          }
          return { account: acc, chatRow: chat };
        },
      );

      const transcript = batch
        .map((t, i) => {
          const who = t.direction === 'outbound' ? 'assistant' : (t.fromName ?? 'user');
          return `#${i + 1} [${t.sentAt.toISOString()}] ${who}: ${t.text}`;
        })
        .join('\n');

      // Reuse the same messages helper. The summarizer doesn't carry persona
      // notes / facts / digests / content hits — it just sees the transcript
      // as its user message, with the worker's prompt as the system block.
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
        `[agent] summarizing chat ${chatPk} (${batch.length} turns, ${routes.primary.provider}:${routes.primary.model}` +
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
          const { result: r, failedOver, usedProvider } = await chatWithFailover(
            ownerId,
            routes,
            {
              messages: flattenChatMessagesForAdapter(messages),
              // System prompt is stable per worker — mark cacheable so
              // the dispatch summariser, which fires in bursts as turns
              // pile up, pays the cache-read rate from the 2nd batch
              // onward on Anthropic-direct.
              cacheControl: { systemPrompt: true },
              ...(typeof params.temperature === 'number'
                ? { temperature: params.temperature }
                : {}),
              ...(typeof params.max_tokens === 'number'
                ? { maxTokens: params.max_tokens }
                : {}),
              ...(typeof params.top_p === 'number' ? { topP: params.top_p } : {}),
            },
            (m) => console.warn(`[summarizer] ${m}`),
          );
          if (failedOver) console.warn(`[summarizer] summarized via backup route (${usedProvider})`);
          recordChatUsage(h, r, r.model || routes.primary.model);
          return r;
        },
      );

      const rawText = result.text.trim();
      if (!rawText) {
        throw new Error('summarizer: empty response — not persisting');
      }

      const topics = parseTopics(rawText, batch.length);
      if (topics.length === 0) {
        throw new Error('summarizer: no usable topics in response — not persisting');
      }

      // Insert one digest node per topic; map each turn to the digest covering it.
      const turnToDigest = new Map<string, string>();
      const inserted: { topic: string; summary: string; turnCount: number }[] = [];

      for (const topic of topics) {
        const turns = topic.turnIndexes
          .map((i) => batch[i - 1])
          .filter((t): t is (typeof batch)[number] => t != null);
        if (turns.length === 0) continue;
        const periodStart = turns[0]!.sentAt.toISOString();
        const periodEnd = turns[turns.length - 1]!.sentAt.toISOString();
        const periodStartShort = periodStart.slice(0, 10);
        const periodEndShort = periodEnd.slice(0, 10);
        const title =
          `${topic.label} · ${periodStartShort} → ${periodEndShort} ` +
          `(${turns.length} turns)`;

        const node = await step(
          {
            name: 'insert_digest_node',
            kind: 'db_write',
            input: { topic: topic.label, turns: turns.length },
          },
          async () => {
            const [n] = await db
              .insert(nodes)
              .values({
                ownerId,
                type: 'note',
                title,
                path: account.branchPath,
                data: {
                  kind: 'conversation_digest',
                  source: 'telegram',
                  chat_id: chatPk,
                  telegram_chat_id: chatRow.telegramChatId,
                  period_start: periodStart,
                  period_end: periodEnd,
                  source_turn_count: turns.length,
                  model: worker.model,
                  agent: worker.slug,
                  // `content` is the note body the /notes UI renders;
                  // `summary` is what the responder loads as Layer-3
                  // memory. Both hold the digest text — for a digest the
                  // body and its summary are the same thing. The extractor
                  // skips conversation-digest notes, so neither is clobbered.
                  content: topic.summary,
                  summary: topic.summary,
                  topic: topic.label,
                  topic_slug: slugifyTopic(topic.label),
                },
                tags: [
                  'conversation-digest',
                  'telegram',
                  `topic:${slugifyTopic(topic.label)}`,
                ],
              })
              .returning({ id: nodes.id });
            if (!n) throw new Error('summarizer: failed to insert digest node');
            return n;
          },
        );
        for (const t of turns) turnToDigest.set(t.id, node.id);
        inserted.push({
          topic: topic.label,
          summary: topic.summary,
          turnCount: turns.length,
        });
      }

      // Defensive: any turn not claimed by a topic falls back to the first
      // topic's digest. The prompt requires full coverage; this is the
      // belt-and-braces fallback for poorly behaved model outputs.
      const fallbackId = turnToDigest.values().next().value;
      if (fallbackId) {
        for (const t of batch) {
          if (!turnToDigest.has(t.id)) turnToDigest.set(t.id, fallbackId);
        }
      }

      await step(
        {
          name: 'mark_turns_digested',
          kind: 'db_write',
          input: { count: batch.length, digests: inserted.length },
        },
        async () => {
          // Group turn ids by digest id so we issue one UPDATE per digest.
          const byDigest = new Map<string, string[]>();
          for (const [turnId, digestId] of turnToDigest) {
            const list = byDigest.get(digestId) ?? [];
            list.push(turnId);
            byDigest.set(digestId, list);
          }
          for (const [digestId, ids] of byDigest) {
            await db
              .update(telegramMessages)
              .set({ digestNodeId: digestId })
              .where(inArray(telegramMessages.id, ids));
          }
        },
      );

      void bumpWorkerUsage(worker.id);

      console.log(
        `[agent] ✓ ${inserted.length} digest(s) created: ` +
          inserted.map((d) => `"${d.topic}" (${d.turnCount}t)`).join(', '),
      );
    },
  );
}

/** ltree path web-conversation digests hang under. There's no per-account
 *  branch for the web /assistant (one stream per owner), so they live under a
 *  fixed label. Path is cosmetic for digests — find_window/responder match by
 *  the `conversation-digest` tag + embedding, not by path. */
const WEB_DIGEST_PATH = 'assistant';

/**
 * Web twin of `summarizeChat` — rolls the oldest undigested `assistant_messages`
 * (the web /assistant surface) into `conversation-digest` notes, so find_window
 * and the responder's Tier-2 memory index web conversation too, not just
 * Telegram. Keyed per-owner (the web surface is one continuous stream, no chat
 * id). Driven from a debounced LISTEN on `summarize_web_due` in main.ts.
 */
export async function summarizeWebConversation(ownerId: string): Promise<void> {
  const worker = await resolveSummarizer(ownerId);
  if (!worker) {
    await recordSkippedTrace({
      kind: 'summarizer_run',
      ownerId,
      subjectId: ownerId,
      subjectKind: 'web_chat',
      disposition: 'no_summarizer_worker',
      details: { surface: 'web', hint: 'Set a default summarizer at /settings/ai-workers.' },
    });
    return;
  }
  // Key pre-flight for CLOUD workers only — `local` is keyless (web path; see
  // the telegram path above + extractor.ts).
  if (worker.provider !== 'local' && !worker.apiKeyId) {
    await recordSkippedTrace({
      kind: 'summarizer_run',
      ownerId,
      subjectId: ownerId,
      subjectKind: 'web_chat',
      disposition: 'no_api_key_id',
      details: { worker_slug: worker.slug, surface: 'web' },
    });
    return;
  }

  const params = (worker.params ?? {}) as SummarizerParams;
  const threshold = params.summarize_threshold ?? 30;
  const batchSize = params.summarize_batch ?? params.window_size ?? 20;

  const countRows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(assistantMessages)
    .where(and(eq(assistantMessages.ownerId, ownerId), isNull(assistantMessages.digestNodeId)));
  const undigested = countRows[0]?.n ?? 0;
  if (undigested < threshold) return;

  await startTrace(
    {
      kind: 'summarizer_run',
      ownerId,
      subjectId: ownerId,
      subjectKind: 'web_chat',
      data: { worker_slug: worker.slug, surface: 'web', threshold, batchSize, undigestedAtStart: undigested },
    },
    async () => {
      const batch = await step(
        { name: 'load_batch', kind: 'db_read', input: { batchSize, surface: 'web' } },
        async (h) => {
          const rows = await db
            .select({
              id: assistantMessages.id,
              direction: assistantMessages.direction,
              text: assistantMessages.text,
              createdAt: assistantMessages.createdAt,
            })
            .from(assistantMessages)
            .where(and(eq(assistantMessages.ownerId, ownerId), isNull(assistantMessages.digestNodeId)))
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
        `[agent] summarizing web conversation (${batch.length} turns, ${routes.primary.provider}:${routes.primary.model}` +
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
          const { result: r, failedOver, usedProvider } = await chatWithFailover(
            ownerId,
            routes,
            {
              messages: flattenChatMessagesForAdapter(messages),
              // Same rationale as the Telegram summariser: system prompt
              // is stable per worker, mark it cacheable.
              cacheControl: { systemPrompt: true },
              ...(typeof params.temperature === 'number' ? { temperature: params.temperature } : {}),
              ...(typeof params.max_tokens === 'number' ? { maxTokens: params.max_tokens } : {}),
              ...(typeof params.top_p === 'number' ? { topP: params.top_p } : {}),
            },
            (m) => console.warn(`[summarizer] ${m}`),
          );
          if (failedOver) console.warn(`[summarizer] summarized via backup route (${usedProvider})`);
          recordChatUsage(h, r, r.model || routes.primary.model);
          return r;
        },
      );

      const rawText = result.text.trim();
      if (!rawText) throw new Error('summarizer: empty response — not persisting');

      const topics = parseTopics(rawText, batch.length);
      if (topics.length === 0) throw new Error('summarizer: no usable topics — not persisting');

      const turnToDigest = new Map<string, string>();
      const inserted: { topic: string; turnCount: number }[] = [];
      for (const topic of topics) {
        const turns = topic.turnIndexes
          .map((i) => batch[i - 1])
          .filter((t): t is (typeof batch)[number] => t != null);
        if (turns.length === 0) continue;
        const periodStart = turns[0]!.createdAt.toISOString();
        const periodEnd = turns[turns.length - 1]!.createdAt.toISOString();
        const title =
          `${topic.label} · ${periodStart.slice(0, 10)} → ${periodEnd.slice(0, 10)} (${turns.length} turns)`;

        const node = await step(
          { name: 'insert_digest_node', kind: 'db_write', input: { topic: topic.label, turns: turns.length } },
          async () => {
            const [n] = await db
              .insert(nodes)
              .values({
                ownerId,
                type: 'note',
                title,
                path: WEB_DIGEST_PATH,
                data: {
                  kind: 'conversation_digest',
                  source: 'web',
                  period_start: periodStart,
                  period_end: periodEnd,
                  source_turn_count: turns.length,
                  model: worker.model,
                  agent: worker.slug,
                  content: topic.summary,
                  summary: topic.summary,
                  topic: topic.label,
                  topic_slug: slugifyTopic(topic.label),
                },
                tags: ['conversation-digest', 'web', `topic:${slugifyTopic(topic.label)}`],
              })
              .returning({ id: nodes.id });
            if (!n) throw new Error('summarizer: failed to insert digest node');
            return n;
          },
        );
        for (const t of turns) turnToDigest.set(t.id, node.id);
        inserted.push({ topic: topic.label, turnCount: turns.length });
      }

      const fallbackId = turnToDigest.values().next().value;
      if (fallbackId) {
        for (const t of batch) if (!turnToDigest.has(t.id)) turnToDigest.set(t.id, fallbackId);
      }

      await step(
        { name: 'mark_turns_digested', kind: 'db_write', input: { count: batch.length, digests: inserted.length } },
        async () => {
          const byDigest = new Map<string, string[]>();
          for (const [turnId, digestId] of turnToDigest) {
            const list = byDigest.get(digestId) ?? [];
            list.push(turnId);
            byDigest.set(digestId, list);
          }
          for (const [digestId, ids] of byDigest) {
            await db
              .update(assistantMessages)
              .set({ digestNodeId: digestId })
              .where(inArray(assistantMessages.id, ids));
          }
        },
      );

      void bumpWorkerUsage(worker.id);
      console.log(
        `[agent] ✓ ${inserted.length} web digest(s): ` +
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
