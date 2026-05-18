/**
 * Mantle agent. Listens on Postgres for `telegram_message_inserted` notifies
 * and replies via OpenRouter.
 *
 *   pg_notify (from migration 0009 trigger; only inbound rows now)
 *      ↓
 *   handleMessage(messageId)
 *      ↓
 *   resolve responder agent from `agents` (highest-priority enabled row)
 *      ↓
 *   load conversation history (last N turns, inbound + outbound, chronological)
 *      ↓
 *   buildChatMessages — system prompt with cache_control for anthropic/* models
 *      ↓
 *   OpenRouter call → send reply → persist outbound row + node → mark inbound processed
 *
 * Agent config (model, persona, API key, memory depth) lives in the DB now —
 * `AGENT_MODEL` / `AGENT_PERSONA` env vars are dead. Configure via
 * `/settings/agents` in the web app.
 */

import postgres from 'postgres';
import { OpenRouter } from '@openrouter/sdk';
import { and, asc, desc, eq, gte, isNull, lt, ne, sql } from 'drizzle-orm';
import {
  db,
  agents,
  entities,
  facts,
  nodes,
  telegramMessages,
  telegramChats,
  type Agent,
  type AgentMemoryConfig,
  type PersonaNote,
} from '@mantle/db';
import { accountForChat, sendMessage } from '@mantle/telegram';
import { getApiKeyById } from '@mantle/api-keys';
import { embed } from '@mantle/embeddings';
import { startTrace, step } from '@mantle/tracing';
import { captureLlmUsage } from './llm-usage.js';
import {
  buildChatMessages,
  type ContentHit,
  type Digest,
  type FactSnippet,
  type HistoryTurn,
} from './messages.js';
import { summarizeChat } from './summarizer.js';
import { extractNode } from './extractor.js';
import { reflect } from './reflector.js';

const USER_ID = process.env.ALLOWED_USER_ID;
const DATABASE_URL = process.env.DATABASE_URL;

if (!USER_ID) {
  console.error('[agent] ALLOWED_USER_ID must be set');
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error('[agent] DATABASE_URL must be set');
  process.exit(1);
}

/** Per-chat in-flight tracker. Prevents two replies racing for the same chat. */
const inflight = new Map<string, Promise<void>>();

/** Fetch the active responder agent for a chat.
 *
 *  Resolution order:
 *    1. If the chat has `responder_agent_id` set AND that agent is enabled
 *       AND its role is responder/assistant/custom, use it. (Custom because
 *       a user may have pinned a one-off agent to a single chat.)
 *    2. Otherwise fall back to the highest-priority enabled responder
 *       (the global default).
 */
async function resolveResponderAgent(
  ownerId: string,
  overrideAgentId: string | null,
): Promise<Agent | null> {
  if (overrideAgentId) {
    const [pinned] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, overrideAgentId), eq(agents.ownerId, ownerId), eq(agents.enabled, true)))
      .limit(1);
    if (pinned) return pinned;
    // Override exists in DB but agent disabled/missing → fall through to global default.
  }
  const [row] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.ownerId, ownerId), eq(agents.role, 'responder'), eq(agents.enabled, true)))
    .orderBy(desc(agents.priority))
    .limit(1);
  return row ?? null;
}

/** Load everything the responder needs for its prompt:
 *    persona_notes + facts + digests + content_index hits + raw turns.
 *  Facts and content hits are vector-keyed off the incoming message, so we
 *  embed the user's text once and reuse it. */
async function loadContext(
  chatPk: string,
  excludeInboundId: string,
  inboundSentAt: Date,
  inboundText: string,
  agent: Agent,
  ownerId: string,
): Promise<{
  personaNotes: PersonaNote[];
  facts: FactSnippet[];
  digests: Digest[];
  contentHits: ContentHit[];
  turns: HistoryTurn[];
}> {
  const memoryConfig = (agent.memoryConfig ?? {}) as AgentMemoryConfig;
  const historyLimit = memoryConfig.history_limit ?? 20;
  const windowHours = memoryConfig.history_window_hours ?? null;
  const digestLimit = memoryConfig.digest_limit ?? 3;
  const factLimit = memoryConfig.fact_limit ?? 10;
  const contentHitLimit = memoryConfig.content_hit_limit ?? 3;

  const personaNotes: PersonaNote[] = (agent.personaNotes ?? []) as PersonaNote[];

  // Embed once for both fact + content_index lookups. Skip if either limit is 0.
  let queryVec: number[] | null = null;
  if ((factLimit > 0 || contentHitLimit > 0) && inboundText.trim().length > 0) {
    try {
      queryVec = await embed(ownerId, inboundText.slice(0, 2000));
    } catch (err) {
      console.error(
        '[agent] loadContext: query embed failed:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ─── Profile facts ──────────────────────────────────────────────────
  let factRows: FactSnippet[] = [];
  if (queryVec && factLimit > 0) {
    const rows = await db
      .select({
        content: facts.content,
        kind: facts.kind,
        entityName: entities.name,
        dist: sql<number>`${facts.embedding} <=> ${JSON.stringify(queryVec)}::vector`,
      })
      .from(facts)
      .leftJoin(entities, eq(facts.entityId, entities.id))
      .where(
        and(
          eq(facts.ownerId, ownerId),
          isNull(facts.validTo),
          sql`${facts.embedding} is not null`,
        ),
      )
      .orderBy(sql`${facts.embedding} <=> ${JSON.stringify(queryVec)}::vector`)
      .limit(factLimit);
    factRows = rows.map((r) => ({
      content: r.content,
      kind: r.kind as string,
      entityName: r.entityName,
    }));
  }

  // ─── Content index hits ────────────────────────────────────────────
  let contentHits: ContentHit[] = [];
  if (queryVec && contentHitLimit > 0) {
    const rows = await db
      .select({
        nodeId: nodes.id,
        title: nodes.title,
        type: nodes.type,
        data: nodes.data,
        dist: sql<number>`${nodes.embedding} <=> ${JSON.stringify(queryVec)}::vector`,
      })
      .from(nodes)
      .where(
        and(
          eq(nodes.ownerId, ownerId),
          sql`${nodes.embedding} is not null`,
          // Exclude conversation-digest notes (already covered by digest layer)
          // and telegram_message rows (those are the conversation itself).
          sql`not (${nodes.tags} @> ARRAY['conversation-digest']::text[])`,
          sql`${nodes.type} <> 'telegram_message'`,
        ),
      )
      .orderBy(sql`${nodes.embedding} <=> ${JSON.stringify(queryVec)}::vector`)
      .limit(contentHitLimit);
    contentHits = rows
      .filter((r) => (r.dist ?? 1) < 0.6) // cosine distance — exclude obvious non-matches
      .map((r) => {
        const data = (r.data ?? {}) as Record<string, unknown>;
        return {
          nodeId: r.nodeId,
          title: r.title,
          type: r.type as string,
          summary: typeof data.summary === 'string' ? data.summary : null,
        };
      });
  }

  // ─── Conversation digests for this chat ────────────────────────────
  const digestRows =
    digestLimit > 0
      ? await db
          .select({ data: nodes.data, createdAt: nodes.createdAt })
          .from(nodes)
          .where(
            and(
              eq(nodes.ownerId, ownerId),
              eq(nodes.type, 'note'),
              sql`${nodes.tags} @> ARRAY['conversation-digest']::text[]`,
              sql`${nodes.data}->>'chat_id' = ${chatPk}`,
            ),
          )
          .orderBy(desc(nodes.createdAt))
          .limit(digestLimit)
      : [];

  const digests: Digest[] = digestRows
    .reverse()
    .map((d) => {
      const data = d.data as Record<string, unknown>;
      const topic = typeof data.topic === 'string' && data.topic.trim() ? data.topic.trim() : null;
      return {
        summary: String(data.summary ?? ''),
        periodStart: String(data.period_start ?? ''),
        periodEnd: String(data.period_end ?? ''),
        topic,
      };
    })
    .filter((d) => d.summary.length > 0);

  // ─── Raw recent turns ──────────────────────────────────────────────
  const conds = [eq(telegramMessages.chatId, chatPk), ne(telegramMessages.id, excludeInboundId)];
  conds.push(lt(telegramMessages.sentAt, inboundSentAt));
  if (windowHours != null && windowHours > 0) {
    const cutoff = new Date(inboundSentAt.getTime() - windowHours * 3600_000);
    conds.push(gte(telegramMessages.sentAt, cutoff));
  }
  const rows = await db
    .select({
      direction: telegramMessages.direction,
      text: telegramMessages.text,
      sentAt: telegramMessages.sentAt,
    })
    .from(telegramMessages)
    .where(and(...conds))
    .orderBy(desc(telegramMessages.sentAt))
    .limit(historyLimit);
  const turns: HistoryTurn[] = rows
    .reverse()
    .map((r) => ({ role: r.direction === 'outbound' ? 'assistant' : 'user', text: r.text }));

  return { personaNotes, facts: factRows, digests, contentHits, turns };
}

async function handleMessage(messageId: string): Promise<void> {
  const [row] = await db
    .select({
      id: telegramMessages.id,
      processed: telegramMessages.processed,
      direction: telegramMessages.direction,
      chatPk: telegramMessages.chatId,
      text: telegramMessages.text,
      sentAt: telegramMessages.sentAt,
      telegramChatId: telegramChats.telegramChatId,
      telegramMessageId: telegramMessages.telegramMessageId,
      fromName: telegramMessages.fromName,
      accountId: telegramMessages.accountId,
      responderAgentId: telegramChats.responderAgentId,
    })
    .from(telegramMessages)
    .innerJoin(telegramChats, eq(telegramMessages.chatId, telegramChats.id))
    .where(eq(telegramMessages.id, messageId))
    .limit(1);

  if (!row) return;
  if (row.processed) return;
  // Defensive — the trigger only fires for inbound but a manual INSERT could
  // get past it. We never reply to our own outbound row.
  if (row.direction !== 'inbound') return;

  if (!row.text || !row.text.trim()) {
    // Sticker, photo-only, etc. — nothing to reply to.
    await db
      .update(telegramMessages)
      .set({ processed: true, processedAt: new Date() })
      .where(eq(telegramMessages.id, row.id));
    return;
  }

  // Atomic claim. Flip processed=true BEFORE doing any work; if the row was
  // already claimed (by a prior invocation that crashed mid-reply, or by a
  // racing notify in another process), the UPDATE returns 0 rows and we
  // exit silently. Tradeoff: a crash between this UPDATE and the actual
  // Telegram send means the user gets no reply — but they don't get a
  // duplicate either, which is the more user-friendly failure mode on a
  // chat surface. Hot-reload-driven duplicates were the original symptom.
  const claim = await db
    .update(telegramMessages)
    .set({ processed: true, processedAt: new Date() })
    .where(and(eq(telegramMessages.id, row.id), eq(telegramMessages.processed, false)))
    .returning({ id: telegramMessages.id });
  if (claim.length === 0) return;

  // Resolve the responder + key BEFORE opening a trace. Failure modes here
  // (no agent, no key) don't generate traces — there's nothing useful to
  // record about "the system was misconfigured."
  const agent = await resolveResponderAgent(USER_ID!, row.responderAgentId);
  if (!agent) {
    console.error(
      `[agent] no enabled responder agent — skipping ${messageId}. Create one at /settings/agents.`,
    );
    return;
  }
  if (!agent.apiKeyId) {
    console.error(
      `[agent] responder agent '${agent.slug}' has no api_key_id set — skipping. Edit it at /settings/agents.`,
    );
    return;
  }
  const apiKey = await getApiKeyById(agent.apiKeyId);
  if (!apiKey) {
    console.error(
      `[agent] api_key_id ${agent.apiKeyId} for agent '${agent.slug}' has no entry — was it deleted?`,
    );
    return;
  }

  const lockKey = row.telegramChatId;
  const prev = inflight.get(lockKey);
  let release: () => void = () => {};
  const lockPromise = new Promise<void>((res) => {
    release = res;
  });
  if (prev) await prev;
  inflight.set(lockKey, lockPromise);

  try {
    await startTrace(
      {
        kind: 'responder_turn',
        ownerId: USER_ID!,
        subjectId: row.id,
        subjectKind: 'telegram_message',
        agentId: agent.id,
        data: { telegramChatId: row.telegramChatId, model: agent.model },
      },
      async () => {
        const { personaNotes, facts: relevantFacts, digests, contentHits, turns: history } =
          await step(
            { name: 'load_context', kind: 'compute', input: { chatId: row.chatPk } },
            async (h) => {
              const ctx = await loadContext(
                row.chatPk,
                row.id,
                row.sentAt,
                row.text,
                agent,
                USER_ID!,
              );
              h.setOutput({
                turnCount: ctx.turns.length,
                digestCount: ctx.digests.length,
                factCount: ctx.facts.length,
                contentHitCount: ctx.contentHits.length,
                personaNoteCount: ctx.personaNotes.length,
              });
              return ctx;
            },
          );

        const messages = await step(
          { name: 'build_messages', kind: 'compute' },
          async (h) => {
            const m = buildChatMessages({
              model: agent.model,
              systemPrompt: agent.systemPrompt,
              personaNotes,
              facts: relevantFacts,
              digests,
              contentHits,
              history,
              newUserText: row.text,
            });
            h.setMeta({ blockCount: m.length });
            return m;
          },
        );

        const client = new OpenRouter({
          apiKey,
          httpReferer: 'https://mantle.crossworks.network',
          appTitle: 'Mantle',
        });

        console.log(
          `[agent] → ${row.fromName ?? 'unknown'} via ${agent.model} (${row.text.length}c, ${history.length} turns, ${digests.length} digests, ${relevantFacts.length} facts, ${contentHits.length} content)`,
        );

        const result = await step(
          { name: 'openrouter_chat', kind: 'llm_call', input: { model: agent.model } },
          async (h) => {
            const r = await client.chat.send({
              chatRequest: {
                model: agent.model,
                messages,
                ...(typeof agent.params?.temperature === 'number'
                  ? { temperature: agent.params.temperature }
                  : {}),
                ...(typeof agent.params?.max_tokens === 'number'
                  ? { maxTokens: agent.params.max_tokens }
                  : {}),
                ...(typeof agent.params?.top_p === 'number' ? { topP: agent.params.top_p } : {}),
              },
            });
            captureLlmUsage(h, r, agent.model);
            return r;
          },
        );

        if (!('choices' in result)) {
          console.error('[agent] unexpected streaming response — skipping');
          return;
        }
        const rawContent = result.choices[0]?.message?.content;
        const reply = typeof rawContent === 'string' ? rawContent.trim() : '';
        if (!reply) {
          console.error('[agent] empty reply from model — not sending');
          return;
        }

        const account = await accountForChat(row.telegramChatId);
        if (!account) {
          console.error('[agent] no enabled telegram account for chat', row.telegramChatId);
          return;
        }

        const telegramMessageIds = await step(
          { name: 'send_telegram', kind: 'send' },
          async (h) => {
            const ids = await sendMessage(account, row.telegramChatId, reply, {
              replyTo: row.telegramMessageId,
            });
            h.setMeta({ chunks: ids.length, replyLength: reply.length });
            return ids;
          },
        );

        await step({ name: 'persist_outbound', kind: 'db_write' }, async (h) => {
          const now = new Date();
          const titleStem = reply.slice(0, 120);
          for (const tgMsgId of telegramMessageIds) {
            const [node] = await db
              .insert(nodes)
              .values({
                ownerId: USER_ID!,
                type: 'telegram_message',
                title: titleStem,
                path: account.branchPath,
                data: {
                  direction: 'outbound',
                  model: agent.model,
                  agent: agent.slug,
                  replyToTelegramMessageId: row.telegramMessageId,
                },
                tags: ['telegram', 'outbound'],
              })
              .returning({ id: nodes.id });
            if (!node) throw new Error('failed to create outbound node');

            await db.insert(telegramMessages).values({
              nodeId: node.id,
              accountId: row.accountId,
              chatId: row.chatPk,
              telegramMessageId: String(tgMsgId),
              text: reply,
              sentAt: now,
              direction: 'outbound',
              agentId: agent.id,
              modelUsed: agent.model,
              replyToId: row.id,
              processed: true,
              processedAt: now,
            });
          }
          h.setMeta({ rows: telegramMessageIds.length });
        });

        // Bump agent usage outside the trace's hot path — best-effort.
        void db
          .update(agents)
          .set({
            lastUsedAt: new Date(),
            usageCount: (agent.usageCount ?? 0) + 1,
            updatedAt: new Date(),
          })
          .where(eq(agents.id, agent.id))
          .catch(() => {});

        console.log(`[agent] ✓ replied (${reply.length}c)`);
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[agent] handle failed:', msg);
  } finally {
    release();
    if (inflight.get(lockKey) === lockPromise) {
      inflight.delete(lockKey);
    }
  }
}

async function drainPending(): Promise<void> {
  // Self-heal: inbound rows that already have an outbound reply but were
  // never marked processed (typically because a previous run crashed or
  // was hot-reloaded between sending Telegram and the final DB UPDATE).
  // Flip them to processed instead of generating a duplicate reply.
  const healed = await db.execute(sql`
    update telegram_messages m
       set processed = true,
           processed_at = coalesce(processed_at, now())
     where m.processed = false
       and m.direction = 'inbound'
       and exists (
         select 1 from telegram_messages r
          where r.reply_to_id = m.id
            and r.direction = 'outbound'
       )
     returning m.id
  `);
  const healedCount = Array.isArray(healed) ? healed.length : (healed as { count?: number }).count ?? 0;
  if (healedCount > 0) {
    console.log(`[agent] drain: healed ${healedCount} previously-replied message(s)`);
  }

  // Now the genuinely-pending set: unprocessed, inbound, no reply yet.
  const rows = await db
    .select({ id: telegramMessages.id })
    .from(telegramMessages)
    .where(and(eq(telegramMessages.processed, false), eq(telegramMessages.direction, 'inbound')))
    .orderBy(asc(telegramMessages.sentAt));
  if (rows.length === 0) {
    console.log('[agent] drain: queue empty');
    return;
  }
  console.log(`[agent] drain: ${rows.length} pending message(s)`);
  for (const r of rows) {
    await handleMessage(r.id);
  }
}

/** Debounce window for summarize_due — collapses a burst of inserts in the
 *  same chat (e.g. user message + agent reply within the same second) into
 *  one summarization check. The check itself is cheap (one indexed COUNT). */
const SUMMARIZE_DEBOUNCE_MS = 2000;
const summarizePending = new Set<string>();
let summarizeTimer: NodeJS.Timeout | null = null;

function scheduleSummarize(chatPk: string): void {
  summarizePending.add(chatPk);
  if (summarizeTimer) return;
  summarizeTimer = setTimeout(() => {
    summarizeTimer = null;
    const batch = [...summarizePending];
    summarizePending.clear();
    for (const id of batch) {
      summarizeChat(id, USER_ID!).catch((err) =>
        console.error('[agent] summarize error:', err instanceof Error ? err.message : err),
      );
    }
  }, SUMMARIZE_DEBOUNCE_MS);
}

/** Debounce window for node_ingested. Same per-node coalescing logic as
 *  summarize_due — multiple inserts of the same node id within 2s collapse
 *  to one extractor call. Cross-node parallelism preserved (Set iteration). */
const EXTRACT_DEBOUNCE_MS = 2000;
const extractPending = new Set<string>();
let extractTimer: NodeJS.Timeout | null = null;

function scheduleExtract(nodeId: string): void {
  extractPending.add(nodeId);
  if (extractTimer) return;
  extractTimer = setTimeout(() => {
    extractTimer = null;
    const batch = [...extractPending];
    extractPending.clear();
    for (const id of batch) {
      extractNode(id, USER_ID!).catch((err) =>
        console.error('[agent] extract error:', err instanceof Error ? err.message : err),
      );
    }
  }, EXTRACT_DEBOUNCE_MS);
}

async function main() {
  const pg = postgres(DATABASE_URL!, { max: 2 });
  console.log('[agent] starting — config from agents table');

  await pg.listen('telegram_message_inserted', (payload: string) => {
    if (!payload) return;
    handleMessage(payload).catch((err) =>
      console.error('[agent] handle error:', err instanceof Error ? err.message : err),
    );
  });
  console.log('[agent] LISTENing on telegram_message_inserted');

  await pg.listen('summarize_due', (payload: string) => {
    if (!payload) return;
    scheduleSummarize(payload);
  });
  console.log('[agent] LISTENing on summarize_due');

  await pg.listen('node_ingested', (payload: string) => {
    if (!payload) return;
    scheduleExtract(payload);
  });
  console.log('[agent] LISTENing on node_ingested');

  // Reflector: slow background pass every REFLECTOR_INTERVAL_MS that
  // checks for new outbound activity and appends to persona_notes when
  // something notable surfaces. No-op if no reflector agent is enabled.
  const REFLECTOR_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
  setInterval(() => {
    reflect(USER_ID!).catch((err) =>
      console.error('[agent] reflect error:', err instanceof Error ? err.message : err),
    );
  }, REFLECTOR_INTERVAL_MS);
  console.log(`[agent] reflector tick every ${REFLECTOR_INTERVAL_MS / 1000}s`);

  await drainPending();

  await new Promise<never>(() => {});
}

main().catch((err) => {
  console.error('[agent] fatal:', err);
  process.exit(1);
});
