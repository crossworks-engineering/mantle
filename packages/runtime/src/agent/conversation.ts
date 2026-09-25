/**
 * Unified per-agent conversation stream — the shared read/write API every
 * channel (web /assistant, Telegram, future WhatsApp) calls. See
 * docs/conversation.md for the full design.
 *
 * The conversation lives in `assistant_messages`, keyed per (owner, agent),
 * NOT per channel — so an agent has ONE forever-thread across every transport.
 * `channel` is provenance + the hint for which transport sends a reply.
 *
 *   recordTurn()              — append one inbound/outbound turn.
 *   loadConversationContext() — assemble the responder's prompt context:
 *                               persona + facts + content hits + digests +
 *                               the last N raw turns (all channels).
 *
 * This module is the single home for logic that used to be copy-pasted as two
 * `loadContext` functions (server/web/lib/assistant.ts + server/api/src/main.ts).
 * It carries the *richer* of the two behaviours forward:
 *   - facts: a 0.85 cosine mismatch guard (drops embedding-space-mismatch rows)
 *   - content hits: a 0.6 cosine relevance cutoff
 *   - digests: filtered by the digest note's `data.agent_id` (per-agent, not
 *     per-chat) — see §4 of the design doc
 * The web surface gains the guard/cutoff/digests when it adopts this module
 * (Phase 2); that's an intended improvement, not a regression.
 */

import { and, desc, eq, gte, inArray, isNull, lt, ne, notInArray, sql } from 'drizzle-orm';
import {
  db,
  currentViewerLevel,
  agents,
  assistantMessages,
  notSuperseded,
  entities,
  facts,
  nodes,
  type Agent,
  type AgentMemoryConfig,
  type AssistantMessage,
  type Node as NodeRow,
  type ConversationAttachment,
  type ConversationChannel,
  type ConversationExternalRef,
  type PersonaNote,
} from '@mantle/db';
import {
  isSmallTalk,
  journalTiersOf,
  loadJournalRules,
  loadJournalTier1Entries,
  notesTargetOf,
  planJournalTier1,
  renderRelevantJournalBlock,
  type Tier1Plan,
} from '@mantle/content';
import { embed } from '@mantle/embeddings';
import {
  CONTEXT_FLOORS,
  HISTORY_RECALL_WINDOW,
  VERSION_THRESHOLD_DEFAULT,
  applyPassageScores,
  applyVersionGroups,
  candidateVersionPairs,
  decisionUseEnabled,
  dropSupersededInPool,
  groupVersions,
  pruneContextItems,
  recallExchanges,
  scoreContextItems,
  scoreHistoryExchanges,
  scoreJournalRules,
  scorePassages,
  type ContextItem,
  type HistoryExchange,
  type HistoryRecallScoring,
} from '@mantle/decisions';
import {
  searchChunks,
  chunkPairSimilarities,
  entityRelationsFor,
  pgArrayLiteral,
  resolveSupersededTargets,
  visibleFactSource,
  withHnswPool,
} from '@mantle/search';
import type {
  ChunkContextHit,
  ContentHit,
  CorpusMapEntry,
  Digest,
  FactSnippet,
  HistoryTurn,
  RelationLine,
} from './messages';
import type { SnapshotItem, ContextSnapshot } from '@mantle/client-types';
import {
  journalSnapshot,
  journalTierConfig,
  journalTiersForTurn,
  passageKey,
} from './conversation/journal-tiers';
import { env } from '@mantle/config';

export type { SnapshotItem, ContextSnapshot };

void agents; // referenced for the Agent type's provenance; silence unused-import lint.

/** Either the pooled `db` or an open transaction handle, so a caller can fold a
 *  conversation turn into a larger atomic write (the Telegram dual-write in
 *  Phase 3 writes telegram_messages + the conversation row in one transaction). */
type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type ConversationContext = {
  personaNotes: PersonaNote[];
  facts: FactSnippet[];
  corpusMap: { entries: CorpusMapEntry[]; truncated: boolean };
  contentHits: ContentHit[];
  chunkHits: ChunkContextHit[];
  relations: RelationLine[];
  digests: Digest[];
  history: HistoryTurn[];
  /** Journal tiers 2 + 3 for this turn ('' unless memory_config.journal_tiers
   *  is `live` and something matched). Owner-internal: only surfaces that
   *  carry the owner's identity pass it on to the prompt. */
  journalRelevant: string;
  snapshot: ContextSnapshot;
};

// ─── Retrieval snapshot (the audit record for /debug/context) ────────────────
// What was retrieved, with the ranking distance that admitted it — plus the
// near-misses each cutoff rejected. Retrieval is recomputed fresh every turn
// against a corpus that keeps changing (new facts, salience/recency drift), so
// none of this can be reconstructed after the fact; the responder surfaces
// persist it as the output of their 'load_context' trace step at turn time.
// Text is snipped and the near-miss lists capped, so a snapshot stays well
// under the tracing layer's 64KB truncation ceiling.

// The snapshot helpers (snip / round3 / the caps) live in
// conversation/select.ts, beside the transforms that build the items.

/** Cap on relationship triples injected. The graph axis of retrieval: vector
 *  finds the facts, this surfaces how their entities relate. How many of the
 *  top facts' entities become anchors is RELATION_ANCHOR_LIMIT, in
 *  conversation/select.ts beside the code that picks them. */
const RELATION_LIMIT = 12;

// ─── Conversational query enrichment (zero-LLM query understanding) ─────────
// A short anaphoric follow-up ("tell me more about that") embeds to nothing
// useful — the referent lives in the previous turns. The prompt already carries
// history so the MODEL can reason, but the RETRIEVAL embedding saw only "tell me
// more about that" and fetched junk. Grounding that embedding in recent turn
// text fixes recall at zero cost (no extra LLM call). Guarded to short +
// referential queries so a clear standalone query ("my bank balance") is never
// diluted. Env kill-switch; full LLM HyDE is deliberately NOT the default — a
// per-turn model call isn't justified when retrieval is already strong.
const QUERY_ENRICH = env('MANTLE_QUERY_ENRICH') !== '0';
const ANAPHORA =
  /\b(that|those|this|these|it|its|they|them|one|ones|there|then|the same|more|again|continue|go on|elaborate|what about|how about)\b/i;

/** A short message that leans on the previous turn for its referent. */
export function looksAnaphoricFollowup(text: string): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 8 && ANAPHORA.test(text);
}

// Tool-outcome and media read-back suffixes live in conversation/format.ts.
// Re-exported here because they were part of this module's surface before the
// split and several callers (and their tests) import them from this path.
export { formatToolRecordSuffix, formatMediaRecordSuffix } from './conversation/format';
import {
  buildCorpusMap,
  buildDigests,
  buildHistory,
  CHUNK_CUTOFF,
  exchangeText,
  groupExchanges,
  mergePreferences,
  patchSuperseded,
  selectChunkHits,
  selectContentHits,
  selectFacts,
  snip,
  staleNodeIds,
  withRecalledExchanges,
  type HistoryRow,
} from './conversation/select';

/** How many section-level passages to auto-pull into context (the fine-grained
 *  complement to the node-level content hits). The budget that matters is
 *  chunk_limit × chunk size: with the larger ~2.75k-char chunks (see
 *  chunkDocText), 8 passages ≈ 22k chars / ~5.5k tokens — enough of a long
 *  procedure/standard to reason over, with far less fragmentation than many
 *  tiny chunks. (Was 12 when chunks were ~1.5k; raising chunk size without
 *  lowering this would silently ~double the budget.) A per-agent
 *  memory_config.chunk_limit still overrides this. */
const CHUNK_LIMIT_DEFAULT = 8;

/** Corpus-map entries injected by default (memory_config.corpus_map_limit
 *  overrides; 0 disables). Selection is most-recently-updated first, so on a
 *  brain past the cap it's the ACTIVE corpus that stays mapped. ~300 title
 *  lines ≈ 4-7k tokens, riding a dedicated prompt-cache breakpoint. */
const CORPUS_MAP_LIMIT_DEFAULT = 300;
/** Node types worth mapping — the authored/ingested corpus. Emails and raw
 *  telegram messages are excluded (huge, conversational); branches are
 *  structure, not content. */
const CORPUS_MAP_TYPES = ['page', 'table', 'file', 'note', 'task', 'app'];
// CHUNK_CUTOFF lives in conversation/select.ts, beside the filter that applies it.

/** Preferences are tiny + high-signal ("the user prefers terse replies"); the
 *  design always-injects the most recent few rather than waiting on a vector
 *  match. 8 keeps the prefix cheap while covering a real person's standing
 *  preferences. */
const PREFERENCE_INJECT_LIMIT = 8;

/** How hard salience demotes a content hit: effective distance = cosine +
 *  λ·(1 − salience). A marketing email (salience 0.25) gets +0.75λ added to its
 *  distance, sliding it below real content / under the 0.6 cutoff. Tunable via
 *  env for the recall eval; 0.15 chosen against the noisy gold cases. Keep in
 *  sync with the same constant in @mantle/search. */
const SALIENCE_LAMBDA = Number(env('MANTLE_SALIENCE_LAMBDA') ?? 0.15);

// ─── Recency / time-decay ────────────────────────────────────────────────
// A saturating age penalty added to the ranking distance: λ·(1 − e^(−age/τ)),
// 0 at age 0 → λ as age → ∞. So among similarly-relevant items the recent one
// wins, but a much-more-relevant old item still beats a marginal recent one
// (a tiebreaker, not a sledgehammer). KIND-AWARE for facts: episodic memories
// ("on the 4th the user said…") are recency-driven; semantic/preference facts are
// stable identity and must NOT decay; factual sits in between. Mild on content.
const RECENCY_TAU_SEC = Number(env('MANTLE_RECENCY_TAU_DAYS') ?? 180) * 86_400;
const RECENCY_EPISODIC = Number(env('MANTLE_RECENCY_EPISODIC') ?? 0.15);
const RECENCY_FACTUAL = 0.05;
const RECENCY_CONTENT = Number(env('MANTLE_RECENCY_CONTENT') ?? 0.06);

/**
 * Append one turn to the unified stream. Defaults `channel` to 'web' and
 * `attachments` to []. Pass `tx` to run inside an existing transaction.
 */
export async function recordTurn(args: {
  ownerId: string;
  agentId: string;
  direction: 'inbound' | 'outbound';
  text: string;
  channel?: ConversationChannel;
  model?: string | null;
  attachments?: ConversationAttachment[];
  externalRef?: ConversationExternalRef | null;
  /** Execution-state projection (migration 0105). Defaults to 'complete' — the
   *  synchronous write path. The durable runner inserts an outbound row 'pending'
   *  at turn start (a stable id before any text) and later flips it via
   *  {@link updateAssistantMessageOutcome}; see docs/live-turn-streaming.md §6. */
  status?: 'pending' | 'complete' | 'failed';
  /** Free-form per-turn metadata persisted on `assistant_messages.data` —
   *  currently the device `{ location }` ping the companion app attaches to
   *  inbound turns. Omitted ⇒ left at the column default. */
  data?: Record<string, unknown> | null;
  tx?: Executor;
}): Promise<AssistantMessage> {
  const exec = args.tx ?? db;
  const [row] = await exec
    .insert(assistantMessages)
    .values({
      ownerId: args.ownerId,
      agentId: args.agentId,
      direction: args.direction,
      text: args.text,
      channel: args.channel ?? 'web',
      model: args.model ?? null,
      attachments: args.attachments ?? [],
      externalRef: args.externalRef ?? null,
      ...(args.status ? { status: args.status } : {}),
      ...(args.data != null ? { data: args.data } : {}),
    })
    .returning();
  if (!row) throw new Error('recordTurn: insert returned no row');
  return row;
}

/**
 * Finalize a 'pending' outbound row written at turn start (see
 * {@link recordTurn}) — fill the reply text + model and flip the status to
 * 'complete', or record a 'failed' turn's error. Idempotent on replay (the
 * durable runner journals the call), and owner-scoped so a turn can only
 * finalize its own row. Returns the updated row, or null if it vanished.
 */
export async function updateAssistantMessageOutcome(args: {
  ownerId: string;
  id: string;
  status: 'complete' | 'failed';
  /** The composed reply text — set on success; left as-is on failure. */
  text?: string;
  model?: string | null;
  /** Human-readable failure reason for a 'failed' turn. */
  error?: string | null;
  /** Reconstructed thought trail (grounded step labels) to persist onto the
   *  row's `data` jsonb so the record survives a reload. Merged, not replaced. */
  thoughts?: Array<{ kind: string; label: string; elapsedMs?: number }>;
  /** Deterministic tool-outcome tally for the turn (the runtime's own ledger,
   *  from summarizeToolOutcomes) — persisted onto `data` so the UI can show
   *  what actually ran vs failed, independent of the reply's claims. */
  toolStats?: {
    calls: number;
    succeeded: number;
    failed: number;
    skipped: number;
    /** Confirm-gated calls parked behind operator approval — not yet run. */
    queued: number;
    failures: Array<{ slug: string; error: string }>;
    /** Artifacts touched by successful write-style calls (see
     *  summarizeToolOutcomes) — read back into the next turn's history. */
    writes?: Array<{ slug: string; id: string; title?: string }>;
  };
  /** Media the turn's tools produced (a `show_image` picture, a generated
   *  image), persisted so the turn still renders them after a reload.
   *
   *  The live `artifacts` channel carries base64 bytes and is returned ONLY by
   *  the legacy blocking response — the streaming path answers 202 with a turn
   *  id and the client reconciles to this durable row, so an artifact that is
   *  never written here is never seen at all. That is exactly what happened to
   *  `show_image`: four successful calls, four artifacts built, and an empty
   *  `attachments` column. Stores the node reference, never the bytes — the
   *  client fetches them from /api/files/files/<nodeId>.
   *
   *  Omitted ⇒ column left untouched (an empty list must not clobber whatever
   *  the insert already recorded). */
  attachments?: ConversationAttachment[];
  tx?: Executor;
}): Promise<AssistantMessage | null> {
  const exec = args.tx ?? db;
  const dataPatch: Record<string, unknown> = {
    ...(args.thoughts != null ? { thoughts: args.thoughts } : {}),
    ...(args.toolStats != null ? { toolStats: args.toolStats } : {}),
  };
  const [row] = await exec
    .update(assistantMessages)
    .set({
      status: args.status,
      ...(args.text != null ? { text: args.text } : {}),
      ...(args.model !== undefined ? { model: args.model } : {}),
      ...(args.error !== undefined ? { error: args.error } : {}),
      ...(args.attachments != null && args.attachments.length > 0
        ? { attachments: args.attachments }
        : {}),
      ...(Object.keys(dataPatch).length > 0
        ? {
            data: sql`${assistantMessages.data} || ${JSON.stringify(dataPatch)}::jsonb`,
          }
        : {}),
    })
    .where(and(eq(assistantMessages.id, args.id), eq(assistantMessages.ownerId, args.ownerId)))
    .returning();
  return row ?? null;
}

/**
 * Stamp both rows of a cancelled turn pair `data.superseded_by = newTurnId` —
 * the premature-Enter correction flow (the user hit Enter too early, cancelled
 * the streaming turn, and re-sent original + correction as one combined turn).
 *
 * Called SYNCHRONOUSLY by the cancel route BEFORE the cancel is published:
 * the client awaits that response before POSTing the combined turn, so the new
 * turn's context load excludes the pair regardless of when the old turn's
 * finalize lands (finalize merges `data`, so the flag survives it). Owner-
 * scoped, so ids guessed from another owner are no-ops. Returns the number of
 * rows stamped (2 on the happy path).
 */
export async function markTurnSuperseded(args: {
  ownerId: string;
  inboundId: string;
  outboundId: string;
  newTurnId: string;
}): Promise<number> {
  const rows = await db
    .update(assistantMessages)
    .set({
      data: sql`${assistantMessages.data} || ${JSON.stringify({ superseded_by: args.newTurnId })}::jsonb`,
    })
    .where(
      and(
        inArray(assistantMessages.id, [args.inboundId, args.outboundId]),
        eq(assistantMessages.ownerId, args.ownerId),
      ),
    )
    .returning({ id: assistantMessages.id });
  return rows.length;
}

/**
 * Assemble the responder's prompt context for one (owner, agent) turn.
 *
 * `excludeMessageId` + `before` exist for the post-insert caller pattern: the
 * Telegram path persists the inbound row first, then loads context, so it must
 * exclude the just-written turn (by id) and only look at turns strictly before
 * it (by time). The web path loads context BEFORE inserting the inbound, so it
 * omits both — the new turn simply isn't in the table yet.
 */
/** An older exchange scored by `history_recall`: its turns, and how many
 *  messages back from the newest its first message sits. */
type RecallExchange = HistoryExchange & { turns: HistoryTurn[]; back: number };

/**
 * The raw history rows, newest first, plus the `history_recall` scoring of
 * the rows past `historyLimit` when that use is on. Started at the top of
 * loadConversationContext and awaited at the end, so the scoring overlaps
 * the embedding and retrieval.
 */
async function loadHistoryRows(o: {
  ownerId: string;
  agentId: string;
  historyLimit: number;
  windowHours: number | null;
  excludeMessageId?: string;
  before?: Date;
  recall: boolean;
}): Promise<{ recentRows: HistoryRow[]; olderRows: HistoryRow[] }> {
  // Only 'complete' turns are real conversation: the durable runner writes the
  // outbound row 'pending' (empty text) at turn start and may end it 'failed'
  // (no usable reply). Either would otherwise leak into a later turn's prompt as
  // an empty/garbage assistant message. Inbound rows are always 'complete', so
  // this filter keeps every user turn. See docs/live-turn-streaming.md §6.
  // Superseded pairs (data.superseded_by — a turn the user cancelled mid-stream
  // and re-sent with a correction) are ALSO excluded: both rows finalize
  // 'complete', so without this the abandoned half-answer would leak back into
  // the next prompt. Recall deliberately still sees them.
  const histConds = [
    eq(assistantMessages.ownerId, o.ownerId),
    eq(assistantMessages.agentId, o.agentId),
    eq(assistantMessages.status, 'complete'),
    notSuperseded(),
  ];
  if (o.excludeMessageId) histConds.push(ne(assistantMessages.id, o.excludeMessageId));
  if (o.before) histConds.push(lt(assistantMessages.createdAt, o.before));
  if (o.windowHours != null && o.windowHours > 0) {
    const base = o.before ?? new Date();
    histConds.push(
      gte(assistantMessages.createdAt, new Date(base.getTime() - o.windowHours * 3600_000)),
    );
  }
  const limit = o.recall ? Math.max(o.historyLimit, HISTORY_RECALL_WINDOW) : o.historyLimit;
  const rows = await db
    .select({
      direction: assistantMessages.direction,
      text: assistantMessages.text,
      createdAt: assistantMessages.createdAt,
      data: assistantMessages.data,
      attachments: assistantMessages.attachments,
    })
    .from(assistantMessages)
    .where(and(...histConds))
    .orderBy(desc(assistantMessages.createdAt))
    .limit(limit);
  return { recentRows: rows.slice(0, o.historyLimit), olderRows: rows.slice(o.historyLimit) };
}

/** The most recent exchange (last user turn onward) as decider context. */
function previousExchangeOf(recentRows: HistoryRow[]): string | null {
  // buildHistory reverses in place: hand it a copy. Comes back oldest first.
  const turns = buildHistory([...recentRows]).history;
  const lastUser = turns.map((t) => t.role).lastIndexOf('user');
  return lastUser >= 0 ? exchangeText(turns.slice(lastUser)) : null;
}

/** `history_recall`: score the rows past `historyLimit` as exchanges. */
async function recallOlderExchanges(o: {
  ownerId: string;
  historyLimit: number;
  inboundText: string;
  recentRows: HistoryRow[];
  olderRows: HistoryRow[];
}): Promise<{ exchanges: RecallExchange[]; scoring: HistoryRecallScoring | null } | null> {
  if (o.olderRows.length === 0) return null;
  const olderTurns = buildHistory([...o.olderRows]).history;
  const exchanges: RecallExchange[] = groupExchanges(olderTurns).map((g, i) => ({
    id: `x${i}`,
    turns: g.turns,
    text: exchangeText(g.turns),
    back: o.historyLimit + (olderTurns.length - g.start),
  }));
  let scoring: HistoryRecallScoring | null = null;
  try {
    scoring = await scoreHistoryExchanges(
      o.ownerId,
      o.inboundText,
      previousExchangeOf(o.recentRows),
      exchanges,
    );
  } catch (err) {
    console.error(
      '[conversation] history recall skipped:',
      err instanceof Error ? err.message : err,
    );
  }
  return { exchanges, scoring };
}

export async function loadConversationContext(args: {
  ownerId: string;
  agent: Agent;
  inboundText: string;
  excludeMessageId?: string;
  before?: Date;
  /** false on surfaces that never render the Journal (team, forum: they
   *  pass `includeIdentity: false` to the assembler). The tiers then do not
   *  run, spend no decider call, and drop nothing as redundant. */
  includeJournal?: boolean;
  /** Node types this turn may not see (a team or forum turn: see
   *  teamHiddenNodeTypes). Set = content hits, passages and facts from those
   *  types are left out, and so are facts with no source node (they come
   *  from the owner's own chats). Unset = owner turn, no filter. */
  excludeNodeTypes?: readonly string[];
}): Promise<ConversationContext> {
  const { ownerId, agent, inboundText } = args;
  const hiddenTypes = args.excludeNodeTypes;
  const factVisible = hiddenTypes ? visibleFactSource(hiddenTypes) : undefined;
  // Inside a viewer scope (a below-admin agent, member logins Phase 0b) the
  // row rules decide what is read, and some arms are not readable at all:
  // entity names and the relation graph (learned from every source, email
  // included), the owner's own chat history and Journal. Those arms are
  // skipped, not left to fail on a permission error.
  const belowAdmin = currentViewerLevel() !== 'admin';
  const entityNameCol = belowAdmin ? sql<string | null>`null` : entities.name;
  const memoryConfig = (agent.memoryConfig ?? {}) as AgentMemoryConfig;
  const historyLimit = memoryConfig.history_limit ?? 20;
  const windowHours = memoryConfig.history_window_hours ?? null;
  const digestLimit = memoryConfig.digest_limit ?? 3;
  const factLimit = memoryConfig.fact_limit ?? 10;
  // Widened 3→5 (audit/recall-eval): 3 was stingy enough to drop genuinely
  // relevant near-misses below the prompt. For "when does my licence disc
  // renew", the user's vehicle page ranked #4 — outside a 3-cap — alongside the
  // actual licence PDF (#3) and a related note (#1). Five short summaries cost
  // little and recover that whole cluster.
  const contentHitLimit = memoryConfig.content_hit_limit ?? 5;
  const chunkLimit = memoryConfig.chunk_limit ?? CHUNK_LIMIT_DEFAULT;
  const corpusMapLimit = memoryConfig.corpus_map_limit ?? CORPUS_MAP_LIMIT_DEFAULT;

  // memory_config.notes_target = 'journal': the notes moved to the Journal
  // (persona-notes-to-journal) and arrive through its tiers instead, which
  // that setting switches to live (journalTiersOf).
  const personaNotes: PersonaNote[] =
    notesTargetOf(memoryConfig) === 'journal' ? [] : ((agent.personaNotes ?? []) as PersonaNote[]);

  // History rows, started now: with the decider's `history_recall` use on, the
  // older rows are scored while the embedding and retrieval below run, so the
  // ~0.5 s never adds to the turn. Awaited where the history is built.
  const recallUse =
    historyLimit > 0 && !belowAdmin && !isSmallTalk(inboundText)
      ? await decisionUseEnabled(ownerId, 'history_recall')
      : null;
  const rowsLoad = belowAdmin
    ? Promise.resolve({ recentRows: [] as HistoryRow[], olderRows: [] as HistoryRow[] })
    : loadHistoryRows({
        ownerId,
        agentId: agent.id,
        historyLimit,
        windowHours,
        excludeMessageId: args.excludeMessageId,
        before: args.before,
        recall: recallUse != null,
      });
  const historyLoad = rowsLoad.then(async ({ recentRows, olderRows }) => ({
    recentRows,
    recall: recallUse
      ? await recallOlderExchanges({ ownerId, historyLimit, inboundText, recentRows, olderRows })
      : null,
  }));

  // Journal tiers (memory_config.journal_tiers, default `shadow`; live when
  // notes_target = journal) and the decider's `journal_recall` use: Jev
  // scores this agent's rules against the message, started now for the same
  // reason as history recall (~0.9 s, spike 13). Runs beside it, not after
  // it. Tier 1's plan comes first: its shown entries stay out of tiers 2/3,
  // its overflow joins the rules Jev scores.
  const journalMode =
    args.includeJournal === false || belowAdmin ? 'off' : journalTiersOf(memoryConfig);
  const userLane = memoryConfig.inject_journal !== false;
  const agentLane = memoryConfig.inject_working_notes !== false;
  const journalWanted =
    journalMode !== 'off' && (userLane || agentLane) && !isSmallTalk(inboundText);
  const tier1Load: Promise<Tier1Plan | null> =
    journalMode !== 'off' && userLane
      ? loadJournalTier1Entries(ownerId, agent.slug).then(planJournalTier1)
      : Promise.resolve(null);
  const journalRecallUse =
    journalWanted && agentLane ? await decisionUseEnabled(ownerId, 'journal_recall') : null;
  const journalRecallLoad = journalRecallUse
    ? Promise.all([rowsLoad, tier1Load.catch(() => null)]).then(async ([{ recentRows }, tier1]) => {
        try {
          const rules = await loadJournalRules(
            ownerId,
            agent.slug,
            tier1?.overflow.map((e) => e.nodeId) ?? [],
          );
          if (rules.length === 0) return null;
          const scoring = await scoreJournalRules(
            ownerId,
            inboundText,
            previousExchangeOf(recentRows),
            rules.map((r) => ({ id: r.nodeId, text: r.body })),
          );
          return scoring ? { rules, scoring } : null;
        } catch (err) {
          console.error(
            '[conversation] journal recall skipped:',
            err instanceof Error ? err.message : err,
          );
          return null;
        }
      })
    : Promise.resolve(null);
  // Surfaced where they are awaited; this only stops an early throw above
  // from leaving a promise unobserved.
  historyLoad.catch(() => {});
  tier1Load.catch(() => {});
  journalRecallLoad.catch(() => {});

  // Embed the inbound once for both fact + content lookups. The embedder is
  // resolved centrally from embedding_config — no per-agent override (the query
  // must share the corpus's vector space).
  let queryVec: number[] | null = null;
  let enrichedQuery: string | null = null;
  if ((factLimit > 0 || contentHitLimit > 0 || journalWanted) && inboundText.trim().length > 0) {
    // For a short anaphoric follow-up, prepend recent turn text so the retrieval
    // embedding resolves the referent instead of embedding "tell me more" alone.
    let embedInput = inboundText;
    if (QUERY_ENRICH && looksAnaphoricFollowup(inboundText) && historyLimit > 0) {
      const conds = [
        eq(assistantMessages.ownerId, ownerId),
        eq(assistantMessages.agentId, agent.id),
      ];
      if (args.excludeMessageId) conds.push(ne(assistantMessages.id, args.excludeMessageId));
      if (args.before) conds.push(lt(assistantMessages.createdAt, args.before));
      const recent = await db
        .select({ text: assistantMessages.text })
        .from(assistantMessages)
        .where(and(...conds))
        .orderBy(desc(assistantMessages.createdAt))
        .limit(2);
      const ctx = recent
        .map((r) => r.text)
        .reverse()
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 400);
      if (ctx) {
        embedInput = `${ctx}\n${inboundText}`;
        enrichedQuery = embedInput;
      }
    }
    try {
      queryVec = await embed(ownerId, embedInput.slice(0, 2000));
    } catch (err) {
      console.error('[conversation] query embed failed:', err instanceof Error ? err.message : err);
    }
  }

  // ─── Profile facts (top-K by vector distance, currently-valid) ──────────
  let factRows: FactSnippet[] = [];
  let factsSentSnap: SnapshotItem[] = [];
  let factsDroppedSnap: SnapshotItem[] = [];
  // The entities whose facts matched this turn — anchors for graph expansion.
  let anchorEntityIds: string[] = [];
  if (queryVec && factLimit > 0) {
    // Pool → re-rank, in one transaction: the recency-adjusted ORDER BY below is
    // not an HNSW-eligible shape (any arithmetic on the distance forces a full
    // scan + sort at scale), so first pull a bare-distance candidate pool through
    // the index, then apply the adjustment within it (see @mantle/search hnsw.ts).
    const factPool = Math.min(Math.max(factLimit * 5, 50), 200);
    const rows = await withHnswPool(factPool, async (tx) => {
      const factConds = and(
        eq(facts.ownerId, ownerId),
        isNull(facts.validTo),
        sql`${facts.embedding} is not null`,
        factVisible,
      );
      // Below admin the pool JOINS the visible source nodes: with a selective
      // row rule the HNSW scan alone stops short (spike: recall@50 0.54 for
      // a client-level role); the join makes it an exact search over the
      // visible facts (recall 1.00, plan section 14b).
      const pooled = (await tx.execute(
        belowAdmin
          ? sql`select ${facts.id} as id from ${facts}
              join ${nodes} on ${nodes.id} = ${facts.sourceNodeId}
              where ${factConds}
              order by ${facts.embedding} <=> ${JSON.stringify(queryVec)}::vector
              limit ${factPool}`
          : sql`select id from ${facts}
              where ${factConds}
              order by ${facts.embedding} <=> ${JSON.stringify(queryVec)}::vector
              limit ${factPool}`,
      )) as unknown as { id: string }[];
      if (pooled.length === 0) return [];
      const hydrate = tx
        .select({
          content: facts.content,
          kind: facts.kind,
          entityId: facts.entityId,
          entityName: entityNameCol,
          sourceNodeId: facts.sourceNodeId,
          dist: sql<number>`${facts.embedding} <=> ${JSON.stringify(queryVec)}::vector`,
        })
        .from(facts)
        .$dynamic();
      return (
        (belowAdmin ? hydrate : hydrate.leftJoin(entities, eq(facts.entityId, entities.id)))
          .where(
            inArray(
              facts.id,
              pooled.map((r) => r.id),
            ),
          )
          // Rank by cosine + a kind-aware age penalty: episodic memories decay
          // (recent ones win), factual mildly, semantic/preference not at all (stable
          // identity). Anchor on valid_from (when the fact became true) → created_at.
          // The mismatch guard below still filters on raw cosine, so recency reorders
          // but never surfaces a garbage-space row.
          .orderBy(
            sql`(${facts.embedding} <=> ${JSON.stringify(queryVec)}::vector) + (case ${facts.kind} when 'episodic' then ${RECENCY_EPISODIC}::float8 when 'factual' then ${RECENCY_FACTUAL}::float8 else 0::float8 end) * (1 - exp(- extract(epoch from (now() - coalesce(${facts.validFrom}, ${facts.createdAt}))) / ${RECENCY_TAU_SEC}::float8))`,
          )
          .limit(factLimit)
      );
    });
    const selection = selectFacts(rows);
    factRows = selection.facts;
    factsSentSnap = selection.sent;
    factsDroppedSnap = selection.dropped;
    anchorEntityIds = selection.anchorEntityIds;
  }

  // ─── Preferences: always-injected, not left to a vector match ───────────
  // The kind taxonomy (memory.md §2) says preferences are small + high-signal
  // and should ride in the prefix every turn — you want "prefers terse replies"
  // present even when the turn isn't about preferences. Vector top-K alone never
  // surfaced them unless the message happened to be similar. Prepend the most
  // recent, deduped against whatever the vector search already returned.
  if (factLimit > 0) {
    const prefQuery = db
      .select({
        content: facts.content,
        kind: facts.kind,
        entityName: entityNameCol,
        sourceNodeId: facts.sourceNodeId,
      })
      .from(facts)
      .$dynamic();
    const prefRows = await (
      belowAdmin ? prefQuery : prefQuery.leftJoin(entities, eq(facts.entityId, entities.id))
    )
      .where(
        and(
          eq(facts.ownerId, ownerId),
          isNull(facts.validTo),
          eq(facts.kind, 'preference'),
          factVisible,
        ),
      )
      .orderBy(desc(facts.updatedAt))
      .limit(PREFERENCE_INJECT_LIMIT);
    const merged = mergePreferences(factRows, factsSentSnap, prefRows);
    factRows = merged.facts;
    factsSentSnap = merged.sent;
  }

  // ─── Content-index hits (excludes digests + raw telegram messages) ──────
  let contentHits: ContentHit[] = [];
  let contentSentSnap: SnapshotItem[] = [];
  let contentDroppedSnap: SnapshotItem[] = [];
  if (queryVec && contentHitLimit > 0) {
    // Same pool → re-rank recipe as the facts block above: bare-distance pool
    // through the HNSW index first, adjusted ordering applied within the pool.
    const contentPool = Math.min(Math.max(contentHitLimit * 5, 50), 200);
    const contentFilters = and(
      eq(nodes.ownerId, ownerId),
      sql`${nodes.embedding} is not null`,
      // Digests are covered by the digest layer; raw telegram messages ARE
      // the conversation itself — neither should surface as a "content hit".
      sql`not (${nodes.tags} @> ARRAY['conversation-digest']::text[])`,
      sql`${nodes.type} <> 'telegram_message'`,
      // System-seeded documentation (Mantle's own docs, origin='system') is a
      // reference corpus, not personal memory — keep it out of the responder's
      // content hits so it can't outrank the user's own notes. The audit caught
      // memory.md winning "3D printer gantry"; there are ~57 such system nodes.
      sql`(${nodes.data}->>'origin') is distinct from 'system'`,
      hiddenTypes?.length ? notInArray(nodes.type, hiddenTypes as NodeRow['type'][]) : undefined,
    );
    const rows = await withHnswPool(contentPool, async (tx) => {
      const pooled = (await tx.execute(
        sql`select id from ${nodes}
            where ${contentFilters}
            order by ${nodes.embedding} <=> ${JSON.stringify(queryVec)}::vector
            limit ${contentPool}`,
      )) as unknown as { id: string }[];
      if (pooled.length === 0) return [];
      return (
        tx
          .select({
            nodeId: nodes.id,
            title: nodes.title,
            type: nodes.type,
            data: nodes.data,
            supersededBy: nodes.supersededBy,
            // Salience-adjusted distance: bulk/marketing mail (low salience) is
            // pushed back so it can't crowd out real content. Non-email nodes have
            // salience 1.0 → no change.
            dist: sql<number>`(${nodes.embedding} <=> ${JSON.stringify(queryVec)}::vector) + ${SALIENCE_LAMBDA} * (1 - ${nodes.salience})`,
          })
          .from(nodes)
          .where(
            inArray(
              nodes.id,
              pooled.map((r) => r.id),
            ),
          )
          // Order by salience-adjusted distance + a MILD recency penalty. The date
          // anchor is the content's own date when it has one (an email's send date —
          // so an old email synced last month reads as old, not fresh), else
          // created_at. Recency only reorders here; the 0.6 cutoff below stays on the
          // salience distance, so a relevant-but-old doc is never dropped for age.
          .orderBy(
            sql`(${nodes.embedding} <=> ${JSON.stringify(queryVec)}::vector) + ${SALIENCE_LAMBDA}::float8 * (1 - ${nodes.salience}) + ${RECENCY_CONTENT}::float8 * (1 - exp(- extract(epoch from (now() - coalesce((${nodes.data}->>'internalDate')::timestamptz, ${nodes.createdAt}))) / ${RECENCY_TAU_SEC}::float8))`,
          )
          .limit(contentHitLimit)
      );
    });
    const selection = selectContentHits(rows);
    contentHits = selection.hits;
    contentSentSnap = selection.sent;
    contentDroppedSnap = selection.dropped;
  }

  // ─── Section-level passages (the fine-grained complement to content hits) ──
  // The coarse per-node embedding is a weak primitive for a long doc; the
  // chunk index holds ~1.5k-char passages with their own embeddings. Pull the
  // closest few so the model gets the actual relevant TEXT, not just the node
  // summary. Salience-aware + system-docs excluded (same hygiene as above);
  // shares the one query embedding.
  let chunkHits: ChunkContextHit[] = [];
  let chunkSentSnap: SnapshotItem[] = [];
  let chunkDroppedSnap: SnapshotItem[] = [];
  // Decider, use `context_pruning`: when on, ONE request later in this
  // function scores facts + content hits + passages together, so the
  // separate passage_scoring call below is skipped (its work is covered).
  // The embedding can exist for the Journal tiers alone: passages, pruning
  // and version grouping ride only on the retrieval an agent asked for
  // (fact_limit / content_hit_limit), as before the tiers.
  const retrievalVec = factLimit > 0 || contentHitLimit > 0 ? queryVec : null;
  const pruningUse = retrievalVec ? await decisionUseEnabled(ownerId, 'context_pruning') : null;
  if (retrievalVec && chunkLimit > 0) {
    const chunkQuery = enrichedQuery ?? inboundText;
    // Decider, use `passage_scoring` (experimental, owner-switched): with it
    // on, pull a wider pool so the scorer can promote a passage search ranked
    // 12th. Off = the same small pool as always.
    const scoringUse = await decisionUseEnabled(ownerId, 'passage_scoring');
    let hits = await searchChunks({
      ownerId,
      embedding: retrievalVec,
      // Hybrid arm: the same text the embedding was computed from, so an
      // exact-term question is rescued by keyword when it embeds poorly.
      q: chunkQuery,
      // small pool so the cutoff can trim without starving
      limit: scoringUse || pruningUse ? Math.min(Math.max(chunkLimit * 2, 16), 25) : chunkLimit + 4,
      excludeSystemOrigin: true,
      excludeTypes: hiddenTypes,
    });
    // One decision call scores each passage 0-3 for "does it answer the
    // question". `live`: weak passages drop and the rest order by score
    // before the budget cut below. `shadow`: traced only, list unchanged.
    // Null (off / failed / slow) = the list search returned. Freshness is
    // NOT the scorer's job — the supersede pass further down stays in charge.
    if (scoringUse && !pruningUse) {
      const scoring = await scorePassages(
        ownerId,
        chunkQuery,
        hits.map((h) => ({
          id: `${h.nodeId}:${h.ordinal}`,
          title: h.nodeTitle,
          heading: h.headingPath,
          text: h.text,
        })),
      );
      if (scoring && scoring.mode === 'live') {
        hits = applyPassageScores(hits, (h) => `${h.nodeId}:${h.ordinal}`, scoring).kept;
      }
    }
    // Same exclusions as content hits: a raw telegram turn isn't a "passage"
    // (it's the conversation), and a weak match isn't worth the tokens.
    const selection = selectChunkHits(hits, chunkLimit);
    chunkHits = selection.hits;
    chunkSentSnap = selection.sent;
    chunkDroppedSnap = selection.dropped;
  }

  // ─── Content-currency: resolve supersession pointers ─────────────────────
  // Hits from superseded nodes (a stale file replaced by a corrected page can
  // still be cosine-closest) get their LIVING successor's id+title so the
  // prompt marks them and the model prefers the current copy. One batched
  // resolution for both hit kinds; zero queries when nothing is superseded.
  {
    const staleIds = staleNodeIds(contentHits, chunkHits);
    if (staleIds.length > 0) {
      const successors = await resolveSupersededTargets(ownerId, staleIds);
      contentHits = patchSuperseded(contentHits, successors);
      chunkHits = patchSuperseded(chunkHits, successors);
    }
  }

  // ─── Context pruning: one decision over everything retrieval admitted ────
  // Decider, use `context_pruning` (experimental, owner-switched). Every fact,
  // content hit and passage above is scored 0-3 for "does it help answer the
  // question" in ONE request; under the threshold (default 1.0) it goes. The
  // spike behind this: the answer relied on 13% of injected context, and the
  // 1.0 cut halves it for ~10% of needed items lost. Preferences are exempt,
  // each block keeps a floor, and freshness is NOT judged here (the supersede
  // pass above already ran). `shadow`: counts only, lists unchanged. Null
  // (off / failed / slow): nothing happens.
  let pruningSnap: ContextSnapshot['pruning'] = undefined;
  if (pruningUse && factRows.length + contentHits.length + chunkHits.length > 0) {
    const factKey = (f: FactSnippet) => `f:${f.content.slice(0, 120)}`;
    const hitKey = (h: ContentHit) => `h:${h.nodeId}`;
    const chunkKey = (c: ChunkContextHit) => `c:${c.nodeId}|${c.text.slice(0, 120)}`;
    const isPref = (f: FactSnippet) => f.kind === 'preference';
    const items: ContextItem[] = [
      ...factRows
        .filter((f) => !isPref(f))
        .map((f) => ({
          id: factKey(f),
          block: 'fact' as const,
          text: `${f.entityName ? `${f.entityName}: ` : ''}${f.content}`,
        })),
      ...contentHits.map((h) => ({
        id: hitKey(h),
        block: 'hit' as const,
        text: `${h.title}: ${h.summary ?? ''}`,
      })),
      ...chunkHits.map((c) => ({
        id: chunkKey(c),
        block: 'chunk' as const,
        text: `${c.title}${c.heading ? ` > ${c.heading}` : ''}: ${c.text}`,
      })),
    ];
    try {
      const scoring = await scoreContextItems(ownerId, enrichedQuery ?? inboundText, items);
      if (scoring) {
        const f = pruneContextItems(factRows, factKey, scoring, {
          exempt: isPref,
          floor: CONTEXT_FLOORS.fact,
        });
        const h = pruneContextItems(contentHits, hitKey, scoring, { floor: CONTEXT_FLOORS.hit });
        const c = pruneContextItems(chunkHits, chunkKey, scoring, { floor: CONTEXT_FLOORS.chunk });
        const charsSaved =
          f.dropped.reduce((n, x) => n + x.content.length, 0) +
          h.dropped.reduce((n, x) => n + (x.summary?.length ?? 0), 0) +
          c.dropped.reduce((n, x) => n + x.text.length, 0);
        pruningSnap = {
          mode: scoring.mode,
          threshold: scoring.threshold,
          wouldDrop: {
            facts: f.dropped.length,
            contentHits: h.dropped.length,
            chunkHits: c.dropped.length,
          },
          charsSaved,
          ms: scoring.ms,
          cached: scoring.cached,
        };
        if (scoring.mode === 'live') {
          // Apply to the lists AND move the matching snapshot rows from sent
          // to dropped, so /debug/context shows what the prompt really got.
          const droppedKeys = new Set([
            ...f.dropped.map(factKey),
            ...h.dropped.map(hitKey),
            ...c.dropped.map(chunkKey),
          ]);
          const snapFactKey = (s: SnapshotItem) => `f:${s.text.slice(0, 120)}`;
          const snapHitKey = (s: SnapshotItem) => `h:${s.nodeId ?? ''}`;
          const snapChunkKey = (s: SnapshotItem) => `c:${s.nodeId ?? ''}|${s.text.slice(0, 120)}`;
          factRows = f.kept;
          contentHits = h.kept;
          chunkHits = c.kept;
          factsDroppedSnap = [
            ...factsDroppedSnap,
            ...factsSentSnap.filter((x) => droppedKeys.has(snapFactKey(x))),
          ];
          factsSentSnap = factsSentSnap.filter((x) => !droppedKeys.has(snapFactKey(x)));
          contentDroppedSnap = [
            ...contentDroppedSnap,
            ...contentSentSnap.filter((x) => droppedKeys.has(snapHitKey(x))),
          ];
          contentSentSnap = contentSentSnap.filter((x) => !droppedKeys.has(snapHitKey(x)));
          chunkDroppedSnap = [
            ...chunkDroppedSnap,
            ...chunkSentSnap.filter((x) => droppedKeys.has(snapChunkKey(x))),
          ];
          chunkSentSnap = chunkSentSnap.filter((x) => !droppedKeys.has(snapChunkKey(x)));
        }
      }
    } catch (err) {
      console.error(
        '[conversation] context pruning skipped:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ─── Version grouping: two versions of one passage ───────────────────────
  // Decider, use `version_grouping` (experimental, owner-switched). Part A is
  // code: a hit whose living successor (resolved by the supersede pass above)
  // is also in the pool goes. Part B asks the model, only for passage pairs
  // from different, UNLINKED nodes that embed as near-copies, "are these two
  // versions of the same passage"; a direct yes at the threshold drops the
  // lower-ranked one. The model never picks the newer copy. Spike: dev-brain
  // page b564522b. `shadow`: counts only. Part B null (off / failed): Part A
  // still counts.
  let versionSnap: ContextSnapshot['versionGrouping'] = undefined;
  const versionUse =
    retrievalVec && contentHits.length + chunkHits.length > 1
      ? await decisionUseEnabled(ownerId, 'version_grouping')
      : null;
  if (versionUse) {
    try {
      const t0 = Date.now();
      const staleHits = dropSupersededInPool(contentHits);
      const staleChunks = dropSupersededInPool(chunkHits);
      const chunkId = (c: ChunkContextHit) => `${c.nodeId}:${c.ordinal ?? ''}`;
      const keyed = staleChunks.kept.filter((c) => c.ordinal !== undefined);
      const sims = await chunkPairSimilarities(
        ownerId,
        keyed.map((c) => ({ nodeId: c.nodeId, ordinal: c.ordinal! })),
      );
      const passages = keyed.map((c) => ({
        id: chunkId(c),
        nodeId: c.nodeId,
        title: c.title,
        heading: c.heading,
        text: c.text,
        supersededBy: c.supersededBy,
      }));
      const pairs = candidateVersionPairs(
        passages,
        sims.map((s) => ({
          a: `${s.a.nodeId}:${s.a.ordinal}`,
          b: `${s.b.nodeId}:${s.b.ordinal}`,
          similarity: s.similarity,
        })),
      );
      const grouping = await groupVersions(ownerId, passages, pairs);
      const versions = grouping
        ? applyVersionGroups(staleChunks.kept, chunkId, grouping)
        : { kept: staleChunks.kept, dropped: [] as ChunkContextHit[] };
      versionSnap = {
        mode: versionUse.mode,
        threshold: grouping?.threshold ?? versionUse.threshold ?? VERSION_THRESHOLD_DEFAULT,
        wouldDrop: {
          superseded: staleHits.dropped.length + staleChunks.dropped.length,
          versions: versions.dropped.length,
        },
        pairs: grouping ? pairs.length : 0,
        ms: Date.now() - t0,
        cached: grouping?.cached ?? false,
      };
      if (versionUse.mode === 'live') {
        // Same snapshot bookkeeping as pruning: dropped rows move from sent
        // to dropped so /debug/context shows what the prompt really got.
        const goneHits = new Set(staleHits.dropped.map((h) => h.nodeId));
        // snip() on both sides: snapshot text is whitespace-collapsed.
        const chunkKey = (nodeId: string, text: string) => `${nodeId}|${snip(text, 120)}`;
        const goneChunks = new Set(
          [...staleChunks.dropped, ...versions.dropped].map((c) => chunkKey(c.nodeId, c.text)),
        );
        contentHits = staleHits.kept;
        chunkHits = versions.kept;
        contentDroppedSnap = [
          ...contentDroppedSnap,
          ...contentSentSnap.filter((x) => goneHits.has(x.nodeId ?? '')),
        ];
        contentSentSnap = contentSentSnap.filter((x) => !goneHits.has(x.nodeId ?? ''));
        chunkDroppedSnap = [
          ...chunkDroppedSnap,
          ...chunkSentSnap.filter((x) => goneChunks.has(chunkKey(x.nodeId ?? '', x.text))),
        ];
        chunkSentSnap = chunkSentSnap.filter(
          (x) => !goneChunks.has(chunkKey(x.nodeId ?? '', x.text)),
        );
      }
    } catch (err) {
      console.error(
        '[conversation] version grouping skipped:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ─── Journal tiers 2 + 3: entries that match this message ──────────────
  // journalTiersOf(memory_config): `shadow` (default) records the pick in the
  // snapshot only; `live` sends it in an uncached per-turn block and drops
  // what a whole entry makes redundant. conversation/journal-tiers.ts.
  let journalRelevant = '';
  let journalSnap: ContextSnapshot['journal'] = undefined;
  const journalRecall = await journalRecallLoad.catch(() => null);
  const tier1 = await tier1Load.catch(() => null);
  if (queryVec && journalMode !== 'off' && (userLane || agentLane)) {
    try {
      const turn = await journalTiersForTurn({
        ownerId,
        agentSlug: agent.slug,
        inboundText,
        queryVec,
        userLane,
        agentLane,
        ...journalTierConfig(memoryConfig),
        tier1,
        recall: journalRecall,
      });
      const { wholeIds, passageKeys } = turn;
      const redundantFact = (f: FactSnippet) => !!f.sourceNodeId && wholeIds.has(f.sourceNodeId);
      const redundantChunk = (c: { nodeId: string; text: string }) =>
        wholeIds.has(c.nodeId) || passageKeys.has(passageKey(c.nodeId, c.text));
      const redundantHit = (h: { nodeId: string }) => wholeIds.has(h.nodeId);
      const live = journalMode === 'live';
      journalSnap = journalSnapshot({
        mode: live ? 'live' : 'shadow',
        turn,
        tier1,
        recall: journalRecall,
        dedupe: {
          facts: factRows.filter(redundantFact).length,
          chunkHits: chunkHits.filter(redundantChunk).length,
          contentHits: contentHits.filter(redundantHit).length,
        },
      });
      if (live) {
        journalRelevant = renderRelevantJournalBlock(turn.relevance, agent.slug);
        const goneFacts = new Set(factRows.filter(redundantFact).map((f) => snip(f.content)));
        factRows = factRows.filter((f) => !redundantFact(f));
        factsDroppedSnap = [
          ...factsDroppedSnap,
          ...factsSentSnap.filter((x) => goneFacts.has(x.text)),
        ];
        factsSentSnap = factsSentSnap.filter((x) => !goneFacts.has(x.text));
        chunkHits = chunkHits.filter((c) => !redundantChunk(c));
        const chunkGone = (x: SnapshotItem) =>
          redundantChunk({ nodeId: x.nodeId ?? '', text: x.text });
        chunkDroppedSnap = [...chunkDroppedSnap, ...chunkSentSnap.filter(chunkGone)];
        chunkSentSnap = chunkSentSnap.filter((x) => !chunkGone(x));
        contentHits = contentHits.filter((h) => !redundantHit(h));
        const hitGone = (x: SnapshotItem) => redundantHit({ nodeId: x.nodeId ?? '' });
        contentDroppedSnap = [...contentDroppedSnap, ...contentSentSnap.filter(hitGone)];
        contentSentSnap = contentSentSnap.filter((x) => !hitGone(x));
      }
    } catch (err) {
      console.error(
        '[conversation] journal relevance skipped:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ─── Corpus map: the cached "what exists" index ─────────────────────────
  // Not a retrieval — a map. The responder otherwise sees only the ~11 nodes
  // vector search surfaces per turn and has no idea what else the brain
  // holds; an audit measured the cost of that blindness (search flailing,
  // the user hand-attaching context on 43% of turns). One indexed select,
  // no embedding involved. Ordering here is updated_at DESC purely for cap
  // SELECTION; presentation sorts by branch/title in the renderer so the
  // block's bytes stay cache-stable.
  let corpusMap: { entries: CorpusMapEntry[]; truncated: boolean } = {
    entries: [],
    truncated: false,
  };
  if (corpusMapLimit > 0) {
    const rows = await db
      .select({
        id: nodes.id,
        type: nodes.type,
        title: nodes.title,
        path: nodes.path,
        data: nodes.data,
      })
      .from(nodes)
      .where(
        and(
          eq(nodes.ownerId, ownerId),
          sql`${nodes.type}::text = any(${pgArrayLiteral(CORPUS_MAP_TYPES)}::text[])`,
          sql`(${nodes.data}->>'origin') is distinct from 'system'`,
          sql`not (${nodes.tags} @> ARRAY['conversation-digest']::text[])`,
        ),
      )
      .orderBy(desc(nodes.updatedAt))
      .limit(corpusMapLimit + 1);
    corpusMap = buildCorpusMap(rows, corpusMapLimit);
  }

  // ─── Entity-anchored expansion: the graph axis ──────────────────────────
  // Vector search found the relevant facts; now surface how THEIR entities
  // relate ("Cross Works banks_with Nedbank") — structured knowledge no vector
  // query can return (memory.md §4.3, "expand each result's neighbourhood").
  let relations: RelationLine[] = [];
  if (!belowAdmin && anchorEntityIds.length > 0) {
    const triples = await entityRelationsFor(ownerId, anchorEntityIds, { limit: RELATION_LIMIT });
    relations = triples.map((t) => ({
      subject: t.subject,
      relation: t.relation,
      object: t.object,
    }));
  }

  // ─── Conversation digests for THIS agent (per-agent, cross-channel) ─────
  // Filtered by the digest note's data.agent_id. Until the unified summarizer
  // (Phase 4) and the digest re-key (Phase 6) land, no digest note carries
  // agent_id, so this returns []. That matches today's web behaviour (which
  // passed digests: []), so adopting this module is a no-op until then.
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
              sql`${nodes.data}->>'agent_id' = ${agent.id}`,
            ),
          )
          .orderBy(desc(nodes.createdAt))
          .limit(digestLimit)
      : [];

  const digests: Digest[] = buildDigests(digestRows);

  // ─── Raw recent turns (all channels, per agent) ─────────────────────────
  // Filters and the early start: loadHistoryRows above.
  const { recentRows, recall } = await historyLoad;
  const built = buildHistory([...recentRows]);
  let history = built.history;
  const historyToolRecords = built.toolRecords;
  const historyMediaRecords = built.mediaRecords;

  // Decider, use `history_recall` (experimental, owner-switched): older
  // exchanges that score at the threshold come back before the recent part,
  // in time order, each marked so the model knows the messages between are
  // not shown. `shadow`: the scores land in the snapshot only. Null scoring
  // (failed / slow) = today's history. Spike 12, dev-brain page c8c2256f.
  let recallSnap: ContextSnapshot['historyRecall'] = undefined;
  if (recall?.scoring) {
    const { scoring } = recall;
    const picked = recallExchanges(recall.exchanges, (e) => e.id, scoring);
    recallSnap = {
      mode: scoring.mode,
      threshold: scoring.threshold,
      exchanges: recall.exchanges.map((e) => ({
        back: e.back,
        score: scoring.scores.has(e.id) ? Math.round(scoring.scores.get(e.id)! * 100) / 100 : null,
        chars: e.text.length,
      })),
      wouldAdd: picked.kept.length,
      chars: picked.kept.reduce((n, e) => n + e.text.length, 0),
      calls: scoring.calls,
      failed: scoring.failed,
      skipped: scoring.skipped,
      ms: scoring.ms,
      cached: scoring.cached,
    };
    if (scoring.mode === 'live' && picked.kept.length > 0) {
      // The recent part is cut by row count: when it opens on a reply, that
      // reply's question is the newest older exchange. Bring it along so the
      // recalled part never leaves the reply answering nothing shown.
      const newestOlder = recall.exchanges[recall.exchanges.length - 1];
      const bridge =
        history[0]?.role === 'assistant' &&
        newestOlder &&
        !picked.kept.includes(newestOlder) &&
        newestOlder.turns[newestOlder.turns.length - 1]?.role === 'user'
          ? newestOlder.turns
          : [];
      history = withRecalledExchanges(history, picked.kept, bridge);
    }
  }

  const snapshot: ContextSnapshot = {
    query: {
      inbound: snip(inboundText, 600),
      enriched: enrichedQuery ? snip(enrichedQuery, 700) : null,
      embedded: queryVec != null,
    },
    facts: { sent: factsSentSnap, dropped: factsDroppedSnap, guard: 0.85 },
    contentHits: { sent: contentSentSnap, dropped: contentDroppedSnap, cutoff: 0.6 },
    chunkHits: { sent: chunkSentSnap, dropped: chunkDroppedSnap, cutoff: CHUNK_CUTOFF },
    relations: relations.map((r) => `${r.subject} —${r.relation}→ ${r.object}`),
    digests: {
      count: digests.length,
      topics: digests.map((d) => d.topic).filter((t): t is string => !!t),
    },
    history: {
      count: history.length,
      toolRecords: historyToolRecords,
      mediaRecords: historyMediaRecords,
    },
    personaNotes: { count: personaNotes.length },
    corpusMap: { count: corpusMap.entries.length, truncated: corpusMap.truncated },
    ...(pruningSnap ? { pruning: pruningSnap } : {}),
    ...(versionSnap ? { versionGrouping: versionSnap } : {}),
    ...(journalSnap ? { journal: journalSnap } : {}),
    ...(recallSnap ? { historyRecall: recallSnap } : {}),
  };

  return {
    personaNotes,
    facts: factRows,
    corpusMap,
    contentHits,
    chunkHits,
    relations,
    digests,
    history,
    journalRelevant,
    snapshot,
  };
}
