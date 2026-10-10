/**
 * Chat archive: "New chat" and "Continue from this" (docs/conversation.md §6c,
 * migration 0231). A thread is a time range over one agent's
 * `assistant_messages`. Archiving closes the open range and opens a new one;
 * the history window, digests and history recall then read only the new
 * range (loadConversationContext), while search, find_window and
 * replay_window still reach the archived turns.
 *
 * The archive action writes ONE summary note per thread (title, summary,
 * embedding, `data.kind = 'chat_archive'`) with one model call on the
 * summarizer worker. It runs inside the archive request only: no trigger, no
 * timer, no retry loop. A failed call leaves the thread archived with a plain
 * title and no summary; `summarizeChatThread` retries it when a person asks.
 * The note is retrievable by relevance and never extracted (no facts from the
 * brain's own answers): see extract/gates.ts.
 */
import { and, asc, count, desc, eq, gte, isNull, lt, min, sql } from 'drizzle-orm';
import {
  db,
  assistantMessages,
  bumpWorkerUsage,
  chatThreads,
  getDefaultWorker,
  nodes,
  notSuperseded,
  agents,
  withDeadlockRetry,
  withNodeInsertHeads,
  type ChatThread,
} from '@mantle/db';
import { NOTES_ASSISTANT_PATH, ensureNotesAssistantFolder } from '@mantle/content/tree';
import { digestEmbedText, embedBatch } from '@mantle/embeddings';
import { startTrace, step } from '@mantle/tracing';
import { chatWithFailover, resolveChatKey, resolveChatRoutes } from './chat-failover';
import { buildChatMessages, flattenChatMessagesForAdapter } from './messages';
import { recordChatUsage } from './llm-usage';

/** A reply is still running in this chat: archiving now would split it. */
export class ChatArchiveBusyError extends Error {
  constructor() {
    super('A reply is still running in this chat. Try again when it has finished.');
    this.name = 'ChatArchiveBusyError';
  }
}

/** The thread to continue from is not an archived thread of this agent. */
export class ChatThreadNotFoundError extends Error {
  constructor() {
    super('That archived chat was not found for this agent.');
    this.name = 'ChatThreadNotFoundError';
  }
}

export type ChatArchiveResult = {
  /** The thread just closed; null when the open chat had no turns. */
  archived: ChatThread | null;
  /** The open thread now; null only for a never-used chat with nothing to do. */
  open: ChatThread | null;
};

/** Caps on what the summary call reads: the thread's digests (newest first)
 *  and its undigested tail. Keeps one archive at about 10k input tokens. */
const SUMMARY_DIGESTS_MAX = 60;
const SUMMARY_TAIL_TURNS_MAX = 40;
const SUMMARY_TURN_CHARS_MAX = 1200;

export const ARCHIVE_SUMMARY_PROMPT = `You name and summarise one archived chat between a user and an AI assistant. You get summaries of its earlier parts (oldest first) and its last turns.

Write:
  - "title": 2-6 words, title case, naming what the chat was mainly about.
  - "summary": 4-10 sentences, plain prose, no headers or lists. Cover the decisions, commitments, open questions and specific facts (people, places, dates, numbers). Say what was left unfinished. Skip small talk.

Be specific: write "Maria presents the Q3 report on Thursday", not "they discussed work".

Output STRICT JSON, no markdown fences, nothing else: {"title": "...", "summary": "..."}`;

/**
 * Archive the open chat of one agent and open a new one. With `continueFrom`
 * (an archived thread of the same agent), the new open thread is seeded with
 * that thread's summary. An empty open chat is not archived: with
 * `continueFrom` it is only re-seeded, without it nothing changes.
 *
 * Throws ChatArchiveBusyError while a reply is pending in the open range, and
 * ChatThreadNotFoundError for a bad `continueFrom`.
 */
export async function archiveAgentChat(o: {
  ownerId: string;
  agentId: string;
  archivedBy?: string | null;
  continueFrom?: string | null;
}): Promise<ChatArchiveResult> {
  const { ownerId, agentId } = o;
  const continueFrom = o.continueFrom ?? null;
  const result = await db.transaction(async (tx) => {
    // One archive at a time per agent chat (a double click, web + Telegram).
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`chat_threads:${ownerId}:${agentId}`}, 0))`,
    );
    const [open] = await tx
      .select()
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.ownerId, ownerId),
          eq(chatThreads.agentId, agentId),
          eq(chatThreads.status, 'open'),
        ),
      )
      .limit(1);
    if (continueFrom) {
      const [seed] = await tx
        .select({ id: chatThreads.id })
        .from(chatThreads)
        .where(
          and(
            eq(chatThreads.ownerId, ownerId),
            eq(chatThreads.agentId, agentId),
            eq(chatThreads.id, continueFrom),
            eq(chatThreads.status, 'archived'),
          ),
        )
        .limit(1);
      if (!seed) throw new ChatThreadNotFoundError();
    }

    const rangeConds = [
      eq(assistantMessages.ownerId, ownerId),
      eq(assistantMessages.agentId, agentId),
      ...(open ? [gte(assistantMessages.createdAt, open.startedAt)] : []),
    ];
    const [pending] = await tx
      .select({ id: assistantMessages.id })
      .from(assistantMessages)
      .where(and(...rangeConds, eq(assistantMessages.status, 'pending')))
      .limit(1);
    if (pending) throw new ChatArchiveBusyError();

    const [stats] = await tx
      .select({ turns: count(), first: min(assistantMessages.createdAt) })
      .from(assistantMessages)
      .where(and(...rangeConds, eq(assistantMessages.status, 'complete'), notSuperseded()));
    const turns = Number(stats?.turns ?? 0);

    if (turns === 0) {
      if (!continueFrom) return { archived: null, open: open ?? null };
      if (open) {
        const [reseeded] = await tx
          .update(chatThreads)
          .set({ seedThreadId: continueFrom, updatedAt: sql`now()` })
          .where(eq(chatThreads.id, open.id))
          .returning();
        return { archived: null, open: reseeded ?? open };
      }
      const [fresh] = await tx
        .insert(chatThreads)
        .values({ ownerId, agentId, status: 'open', seedThreadId: continueFrom })
        .returning();
      return { archived: null, open: fresh ?? null };
    }

    let archived: ChatThread | undefined;
    if (open) {
      [archived] = await tx
        .update(chatThreads)
        .set({
          status: 'archived',
          archivedAt: sql`now()`,
          turnCount: turns,
          archivedBy: o.archivedBy ?? null,
          updatedAt: sql`now()`,
        })
        .where(eq(chatThreads.id, open.id))
        .returning();
    } else {
      // First archive of a forever-thread: its range starts at its first turn.
      [archived] = await tx
        .insert(chatThreads)
        .values({
          ownerId,
          agentId,
          status: 'archived',
          startedAt: stats?.first ?? sql`now()`,
          archivedAt: sql`now()`,
          turnCount: turns,
          archivedBy: o.archivedBy ?? null,
        })
        .returning();
    }
    // The new range starts where the old one ends (the same transaction
    // clock), so every turn lands in exactly one thread.
    const [fresh] = await tx
      .insert(chatThreads)
      .values({
        ownerId,
        agentId,
        status: 'open',
        startedAt: sql`now()`,
        seedThreadId: continueFrom,
      })
      .returning();
    return { archived: archived ?? null, open: fresh ?? null };
  });

  if (!result.archived) return result;
  const archived = await summarizeChatThread(ownerId, result.archived.id).catch((err) => {
    console.warn(
      `[chat-archive] summary failed, thread kept with a plain title: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  });
  return { archived: archived ?? result.archived, open: result.open };
}

/**
 * Name and summarise one archived thread: one model call, one note, the
 * thread row updated. Called by archiveAgentChat, and by a person's
 * "Summarise" retry for a thread whose first attempt failed. A thread that
 * already has a summary is returned unchanged: this never re-bills.
 */
export async function summarizeChatThread(
  ownerId: string,
  threadId: string,
): Promise<ChatThread | null> {
  const [thread] = await db
    .select()
    .from(chatThreads)
    .where(and(eq(chatThreads.ownerId, ownerId), eq(chatThreads.id, threadId)))
    .limit(1);
  if (!thread || thread.status !== 'archived' || !thread.archivedAt) return thread ?? null;
  if (thread.summaryNodeId) return thread;
  const end = thread.archivedAt;

  const inRange = [
    eq(assistantMessages.ownerId, ownerId),
    eq(assistantMessages.agentId, thread.agentId),
    gte(assistantMessages.createdAt, thread.startedAt),
    lt(assistantMessages.createdAt, end),
    eq(assistantMessages.status, 'complete'),
    notSuperseded(),
  ];
  const [firstInbound] = await db
    .select({ text: assistantMessages.text })
    .from(assistantMessages)
    .where(and(...inRange, eq(assistantMessages.direction, 'inbound')))
    .orderBy(asc(assistantMessages.createdAt))
    .limit(1);
  const plainTitle = fallbackThreadTitle(firstInbound?.text ?? null, thread.startedAt);

  const worker = await getDefaultWorker(ownerId, 'summarizer');
  const keyOk = worker ? (await resolveChatKey(ownerId, worker)).ok : false;
  if (!worker || !keyOk) return setThreadTitle(thread, plainTitle);

  const [digestRows, tailRows, agentRow] = await Promise.all([
    db
      .select({ data: nodes.data })
      .from(nodes)
      .where(
        and(
          eq(nodes.ownerId, ownerId),
          eq(nodes.type, 'note'),
          sql`${nodes.tags} @> ARRAY['conversation-digest']::text[]`,
          sql`${nodes.data}->>'agent_id' = ${thread.agentId}`,
          sql`(${nodes.data}->>'period_start')::timestamptz >= ${thread.startedAt.toISOString()}::timestamptz`,
          sql`(${nodes.data}->>'period_start')::timestamptz < ${end.toISOString()}::timestamptz`,
        ),
      )
      .orderBy(desc(sql`(${nodes.data}->>'period_start')::timestamptz`))
      .limit(SUMMARY_DIGESTS_MAX),
    db
      .select({
        direction: assistantMessages.direction,
        text: assistantMessages.text,
        createdAt: assistantMessages.createdAt,
      })
      .from(assistantMessages)
      .where(and(...inRange, isNull(assistantMessages.digestNodeId)))
      .orderBy(desc(assistantMessages.createdAt))
      .limit(SUMMARY_TAIL_TURNS_MAX),
    db
      .select({ slug: agents.slug })
      .from(agents)
      .where(eq(agents.id, thread.agentId))
      .limit(1)
      .then((r) => r[0] ?? null),
  ]);
  const input = archiveSummaryInput(
    digestRows.reverse().map((d) => d.data as Record<string, unknown>),
    tailRows.reverse(),
  );
  if (!input) return setThreadTitle(thread, plainTitle);
  const agentSlug = agentRow?.slug ?? thread.agentId;

  return startTrace(
    {
      kind: 'summarizer_run',
      ownerId,
      subjectId: thread.id,
      subjectKind: 'chat_thread',
      agentId: thread.agentId,
      data: {
        worker_slug: worker.slug,
        agent_id: thread.agentId,
        agent_slug: agentSlug,
        chat_archive: true,
        digests: digestRows.length,
        tail_turns: tailRows.length,
      },
    },
    async () => {
      const routes = resolveChatRoutes(worker);
      const messages = buildChatMessages({
        model: worker.model,
        provider: worker.provider,
        systemPrompt: ARCHIVE_SUMMARY_PROMPT,
        personaNotes: [],
        facts: [],
        digests: [],
        contentHits: [],
        history: [],
        newUserText: input,
      });
      const reply = await step(
        {
          name: 'llm_archive_summary',
          kind: 'llm_call',
          input: { model: worker.model, provider: worker.provider },
        },
        async (h) => {
          const { result: r } = await chatWithFailover(
            ownerId,
            routes,
            {
              messages: flattenChatMessagesForAdapter(messages),
              cacheControl: { systemPrompt: true },
              maxTokens: 1200,
            },
            (m) => console.warn(`[chat-archive] ${m}`),
          );
          recordChatUsage(h, r, r.model || routes.primary.model);
          return r;
        },
      );
      void bumpWorkerUsage(worker.id);
      const parsed = parseArchiveSummary(reply.text);
      if (!parsed.summary) return setThreadTitle(thread, parsed.title ?? plainTitle);
      const title = parsed.title ?? plainTitle;
      const summary = parsed.summary;

      let vec: number[] | null = null;
      try {
        vec = (await embedBatch(ownerId, [digestEmbedText(title, summary)]))[0] ?? null;
      } catch (err) {
        console.warn(
          `[chat-archive] summary embed failed, note kept without one: ${err instanceof Error ? err.message : err}`,
        );
      }

      await ensureNotesAssistantFolder(ownerId);
      const periodStart = thread.startedAt.toISOString();
      const periodEnd = end.toISOString();
      return step(
        { name: 'persist_archive_summary', kind: 'db_write', input: { title } },
        // The notes folder's head first (plan U1). The model has answered
        // and the note is embedded, so a retry repeats only this write.
        async () =>
          withDeadlockRetry(() =>
            withNodeInsertHeads(
              ownerId,
              [{ type: 'note', path: NOTES_ASSISTANT_PATH }],
              async (tx) => {
                const [node] = await tx
                  .insert(nodes)
                  .values({
                    ownerId,
                    type: 'note',
                    title: `Chat: ${title} · ${periodStart.slice(0, 10)} → ${periodEnd.slice(0, 10)}`,
                    path: NOTES_ASSISTANT_PATH,
                    ...(vec ? { embedding: vec } : {}),
                    data: {
                      kind: 'chat_archive',
                      thread_id: thread.id,
                      agent_id: thread.agentId,
                      agent_slug: agentSlug,
                      period_start: periodStart,
                      period_end: periodEnd,
                      source_turn_count: thread.turnCount,
                      model: worker.model,
                      summarizer_worker: worker.slug,
                      topic: title,
                      summary,
                      content: summary,
                    },
                    tags: ['chat-archive', `agent:${tagSlug(agentSlug)}`],
                  })
                  .returning({ id: nodes.id });
                if (!node) throw new Error('chat-archive: failed to insert the summary note');
                const [row] = await tx
                  .update(chatThreads)
                  .set({ title, summaryNodeId: node.id, updatedAt: sql`now()` })
                  .where(eq(chatThreads.id, thread.id))
                  .returning();
                return row ?? thread;
              },
            ),
          ),
      );
    },
  );
}

async function setThreadTitle(thread: ChatThread, title: string): Promise<ChatThread> {
  if (thread.title) return thread;
  const [row] = await db
    .update(chatThreads)
    .set({ title, updatedAt: sql`now()` })
    .where(eq(chatThreads.id, thread.id))
    .returning();
  return row ?? thread;
}

/** A title with no model: the first user line, else the start date. */
export function fallbackThreadTitle(firstInbound: string | null, startedAt: Date): string {
  const line = (firstInbound ?? '').replace(/\s+/g, ' ').trim();
  if (line) return line.length > 60 ? `${line.slice(0, 57).trimEnd()}...` : line;
  return `Chat of ${startedAt.toISOString().slice(0, 10)}`;
}

/** The summary call's input: the thread's digests, then its undigested last
 *  turns, each turn capped. Null when there is nothing to summarise. */
export function archiveSummaryInput(
  digests: Array<Record<string, unknown>>,
  tail: Array<{ direction: string; text: string; createdAt: Date }>,
): string | null {
  const parts: string[] = [];
  const digestLines = digests
    .map((d) => {
      const summary = typeof d.summary === 'string' ? d.summary.trim() : '';
      if (!summary) return null;
      const topic = typeof d.topic === 'string' && d.topic.trim() ? ` ${d.topic.trim()}:` : '';
      const start = typeof d.period_start === 'string' ? d.period_start.slice(0, 10) : '?';
      return `- [${start}]${topic} ${summary}`;
    })
    .filter((l): l is string => l != null);
  if (digestLines.length > 0) parts.push(`Earlier parts (summaries):\n${digestLines.join('\n')}`);
  const turnLines = tail
    .filter((t) => t.text.trim())
    .map((t, i) => {
      const who = t.direction === 'outbound' ? 'assistant' : 'user';
      const text =
        t.text.length > SUMMARY_TURN_CHARS_MAX
          ? `${t.text.slice(0, SUMMARY_TURN_CHARS_MAX)} [cut]`
          : t.text;
      return `#${i + 1} [${t.createdAt.toISOString()}] ${who}: ${text}`;
    });
  if (turnLines.length > 0) parts.push(`Last turns:\n${turnLines.join('\n')}`);
  return parts.length > 0 ? parts.join('\n\n') : null;
}

/** Parse `{"title", "summary"}`, tolerating code fences and a prose reply
 *  (the prose becomes the summary with no title). */
export function parseArchiveSummary(raw: string): { title: string | null; summary: string | null } {
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  if (!text) return { title: null, summary: null };
  const start = text.indexOf('{');
  const stop = text.lastIndexOf('}');
  if (start >= 0 && stop > start) {
    try {
      const j = JSON.parse(text.slice(start, stop + 1)) as Record<string, unknown>;
      const title =
        typeof j.title === 'string' && j.title.trim() ? j.title.trim().slice(0, 80) : null;
      const summary = typeof j.summary === 'string' && j.summary.trim() ? j.summary.trim() : null;
      if (title || summary) return { title, summary };
    } catch {
      // fall through to prose
    }
  }
  return { title: null, summary: text };
}

function tagSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}
