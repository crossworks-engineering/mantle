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
 * `loadContext` functions (apps/web/lib/assistant.ts + apps/agent/src/main.ts).
 * It carries the *richer* of the two behaviours forward:
 *   - facts: a 0.85 cosine mismatch guard (drops embedding-space-mismatch rows)
 *   - content hits: a 0.6 cosine relevance cutoff
 *   - digests: filtered by the digest note's `data.agent_id` (per-agent, not
 *     per-chat) — see §4 of the design doc
 * The web surface gains the guard/cutoff/digests when it adopts this module
 * (Phase 2); that's an intended improvement, not a regression.
 */

import { and, desc, eq, gte, isNull, lt, ne, sql } from 'drizzle-orm';
import {
  db,
  agents,
  assistantMessages,
  entities,
  facts,
  nodes,
  type Agent,
  type AgentMemoryConfig,
  type AssistantMessage,
  type ConversationAttachment,
  type ConversationChannel,
  type ConversationExternalRef,
  type PersonaNote,
} from '@mantle/db';
import { embed } from '@mantle/embeddings';
import { searchChunks, entityRelationsFor } from '@mantle/search';
import type {
  ChunkContextHit,
  ContentHit,
  Digest,
  FactSnippet,
  HistoryTurn,
  RelationLine,
} from './messages';

void agents; // referenced for the Agent type's provenance; silence unused-import lint.

/** Either the pooled `db` or an open transaction handle, so a caller can fold a
 *  conversation turn into a larger atomic write (the Telegram dual-write in
 *  Phase 3 writes telegram_messages + the conversation row in one transaction). */
type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type ConversationContext = {
  personaNotes: PersonaNote[];
  facts: FactSnippet[];
  contentHits: ContentHit[];
  chunkHits: ChunkContextHit[];
  relations: RelationLine[];
  digests: Digest[];
  history: HistoryTurn[];
};

/** Entity-anchored expansion: how many of the top facts' entities to expand, and
 *  the cap on relationship triples injected. The graph axis of retrieval —
 *  vector finds the facts, this surfaces how their entities relate. */
const RELATION_ANCHOR_LIMIT = 5;
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
const QUERY_ENRICH = process.env.MANTLE_QUERY_ENRICH !== '0';
const ANAPHORA =
  /\b(that|those|this|these|it|its|they|them|one|ones|there|then|the same|more|again|continue|go on|elaborate|what about|how about)\b/i;

/** A short message that leans on the previous turn for its referent. */
export function looksAnaphoricFollowup(text: string): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 8 && ANAPHORA.test(text);
}

/** How many section-level passages to auto-pull into context (the fine-grained
 *  complement to the node-level content hits). Default kept small — these carry
 *  real passage text (~1.5k chars each), so they're the priciest context slice. */
const CHUNK_LIMIT_DEFAULT = 3;
/** Cosine cutoff for a chunk to be worth injecting. Looser than the node cutoff
 *  (0.6): a passage can match tightly on a sub-topic the node summary misses. */
const CHUNK_CUTOFF = 0.65;

/** Preferences are tiny + high-signal ("Jason prefers terse replies"); the
 *  design always-injects the most recent few rather than waiting on a vector
 *  match. 8 keeps the prefix cheap while covering a real person's standing
 *  preferences. */
const PREFERENCE_INJECT_LIMIT = 8;

/** How hard salience demotes a content hit: effective distance = cosine +
 *  λ·(1 − salience). A marketing email (salience 0.25) gets +0.75λ added to its
 *  distance, sliding it below real content / under the 0.6 cutoff. Tunable via
 *  env for the recall eval; 0.15 chosen against the noisy gold cases. Keep in
 *  sync with the same constant in @mantle/search. */
const SALIENCE_LAMBDA = Number(process.env.MANTLE_SALIENCE_LAMBDA ?? 0.15);

// ─── Recency / time-decay ────────────────────────────────────────────────
// A saturating age penalty added to the ranking distance: λ·(1 − e^(−age/τ)),
// 0 at age 0 → λ as age → ∞. So among similarly-relevant items the recent one
// wins, but a much-more-relevant old item still beats a marginal recent one
// (a tiebreaker, not a sledgehammer). KIND-AWARE for facts: episodic memories
// ("on the 4th Jason said…") are recency-driven; semantic/preference facts are
// stable identity and must NOT decay; factual sits in between. Mild on content.
const RECENCY_TAU_SEC = Number(process.env.MANTLE_RECENCY_TAU_DAYS ?? 180) * 86_400;
const RECENCY_EPISODIC = Number(process.env.MANTLE_RECENCY_EPISODIC ?? 0.15);
const RECENCY_FACTUAL = 0.05;
const RECENCY_CONTENT = Number(process.env.MANTLE_RECENCY_CONTENT ?? 0.06);

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
    })
    .returning();
  if (!row) throw new Error('recordTurn: insert returned no row');
  return row;
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
export async function loadConversationContext(args: {
  ownerId: string;
  agent: Agent;
  inboundText: string;
  excludeMessageId?: string;
  before?: Date;
}): Promise<ConversationContext> {
  const { ownerId, agent, inboundText } = args;
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

  const personaNotes: PersonaNote[] = (agent.personaNotes ?? []) as PersonaNote[];

  // Embed the inbound once for both fact + content lookups. The embedder is
  // resolved centrally from embedding_config — no per-agent override (the query
  // must share the corpus's vector space).
  let queryVec: number[] | null = null;
  if ((factLimit > 0 || contentHitLimit > 0) && inboundText.trim().length > 0) {
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
      if (ctx) embedInput = `${ctx}\n${inboundText}`;
    }
    try {
      queryVec = await embed(ownerId, embedInput.slice(0, 2000));
    } catch (err) {
      console.error(
        '[conversation] query embed failed:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ─── Profile facts (top-K by vector distance, currently-valid) ──────────
  let factRows: FactSnippet[] = [];
  // The entities whose facts matched this turn — anchors for graph expansion.
  let anchorEntityIds: string[] = [];
  if (queryVec && factLimit > 0) {
    const rows = await db
      .select({
        content: facts.content,
        kind: facts.kind,
        entityId: facts.entityId,
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
      // Rank by cosine + a kind-aware age penalty: episodic memories decay
      // (recent ones win), factual mildly, semantic/preference not at all (stable
      // identity). Anchor on valid_from (when the fact became true) → created_at.
      // The mismatch guard below still filters on raw cosine, so recency reorders
      // but never surfaces a garbage-space row.
      .orderBy(
        sql`(${facts.embedding} <=> ${JSON.stringify(queryVec)}::vector) + (case ${facts.kind} when 'episodic' then ${RECENCY_EPISODIC}::float8 when 'factual' then ${RECENCY_FACTUAL}::float8 else 0::float8 end) * (1 - exp(- extract(epoch from (now() - coalesce(${facts.validFrom}, ${facts.createdAt}))) / ${RECENCY_TAU_SEC}::float8))`,
      )
      .limit(factLimit);
    factRows = rows
      // Mismatch guard: if the query vector and stored fact vectors live in
      // different embedding-model spaces, cosine distances cluster near 1.0.
      // Drop those so a mismatch degrades to "no facts" (visible) rather than
      // surfacing garbage-space rows. Loose by design (0.85) — legitimate facts
      // still pass even when only loosely related.
      .filter((r) => (r.dist ?? 1) < 0.85)
      .map((r) => ({ content: r.content, kind: r.kind as string, entityName: r.entityName }));
    // Anchor entities = the entities of the top matching facts (rank order,
    // distinct), the seeds for graph expansion below.
    const ranked: string[] = [];
    for (const r of rows) {
      if ((r.dist ?? 1) >= 0.85 || !r.entityId) continue;
      if (!ranked.includes(r.entityId)) ranked.push(r.entityId);
      if (ranked.length >= RELATION_ANCHOR_LIMIT) break;
    }
    anchorEntityIds = ranked;
  }

  // ─── Preferences: always-injected, not left to a vector match ───────────
  // The kind taxonomy (memory.md §2) says preferences are small + high-signal
  // and should ride in the prefix every turn — you want "prefers terse replies"
  // present even when the turn isn't about preferences. Vector top-K alone never
  // surfaced them unless the message happened to be similar. Prepend the most
  // recent, deduped against whatever the vector search already returned.
  if (factLimit > 0) {
    const prefRows = await db
      .select({ content: facts.content, kind: facts.kind, entityName: entities.name })
      .from(facts)
      .leftJoin(entities, eq(facts.entityId, entities.id))
      .where(
        and(eq(facts.ownerId, ownerId), isNull(facts.validTo), eq(facts.kind, 'preference')),
      )
      .orderBy(desc(facts.updatedAt))
      .limit(PREFERENCE_INJECT_LIMIT);
    const seen = new Set(factRows.map((f) => f.content));
    const prefs = prefRows
      .filter((p) => !seen.has(p.content))
      .map((p) => ({ content: p.content, kind: p.kind as string, entityName: p.entityName }));
    if (prefs.length) factRows = [...prefs, ...factRows];
  }

  // ─── Content-index hits (excludes digests + raw telegram messages) ──────
  let contentHits: ContentHit[] = [];
  if (queryVec && contentHitLimit > 0) {
    const rows = await db
      .select({
        nodeId: nodes.id,
        title: nodes.title,
        type: nodes.type,
        data: nodes.data,
        // Salience-adjusted distance: bulk/marketing mail (low salience) is
        // pushed back so it can't crowd out real content. Non-email nodes have
        // salience 1.0 → no change.
        dist: sql<number>`(${nodes.embedding} <=> ${JSON.stringify(queryVec)}::vector) + ${SALIENCE_LAMBDA} * (1 - ${nodes.salience})`,
      })
      .from(nodes)
      .where(
        and(
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
      .limit(contentHitLimit);
    contentHits = rows
      .filter((r) => (r.dist ?? 1) < 0.6) // salience-adjusted cutoff — drop non-matches + demoted bulk
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

  // ─── Section-level passages (the fine-grained complement to content hits) ──
  // The coarse per-node embedding is a weak primitive for a long doc; the
  // chunk index holds ~1.5k-char passages with their own embeddings. Pull the
  // closest few so the model gets the actual relevant TEXT, not just the node
  // summary. Salience-aware + system-docs excluded (same hygiene as above);
  // shares the one query embedding.
  let chunkHits: ChunkContextHit[] = [];
  if (queryVec && chunkLimit > 0) {
    const hits = await searchChunks({
      ownerId,
      embedding: queryVec,
      limit: chunkLimit + 4, // small pool so the cutoff can trim without starving
      excludeSystemOrigin: true,
    });
    chunkHits = hits
      // Same exclusions as content hits: a raw telegram turn isn't a "passage"
      // (it's the conversation), and a weak match isn't worth the tokens.
      .filter((h) => h.distance < CHUNK_CUTOFF && h.nodeType !== 'telegram_message')
      .slice(0, chunkLimit)
      .map((h) => ({
        nodeId: h.nodeId,
        title: h.nodeTitle,
        heading: h.headingPath,
        text: h.text,
      }));
  }

  // ─── Entity-anchored expansion: the graph axis ──────────────────────────
  // Vector search found the relevant facts; now surface how THEIR entities
  // relate ("Cross Works banks_with Nedbank") — structured knowledge no vector
  // query can return (memory.md §4.3, "expand each result's neighbourhood").
  let relations: RelationLine[] = [];
  if (anchorEntityIds.length > 0) {
    const triples = await entityRelationsFor(ownerId, anchorEntityIds, { limit: RELATION_LIMIT });
    relations = triples.map((t) => ({ subject: t.subject, relation: t.relation, object: t.object }));
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

  // ─── Raw recent turns (all channels, per agent) ─────────────────────────
  const histConds = [
    eq(assistantMessages.ownerId, ownerId),
    eq(assistantMessages.agentId, agent.id),
  ];
  if (args.excludeMessageId) histConds.push(ne(assistantMessages.id, args.excludeMessageId));
  if (args.before) histConds.push(lt(assistantMessages.createdAt, args.before));
  if (windowHours != null && windowHours > 0) {
    const base = args.before ?? new Date();
    histConds.push(gte(assistantMessages.createdAt, new Date(base.getTime() - windowHours * 3600_000)));
  }
  const rows = await db
    .select({
      direction: assistantMessages.direction,
      text: assistantMessages.text,
      createdAt: assistantMessages.createdAt,
    })
    .from(assistantMessages)
    .where(and(...histConds))
    .orderBy(desc(assistantMessages.createdAt))
    .limit(historyLimit);
  const history: HistoryTurn[] = rows
    .reverse()
    .map((r) => ({ role: r.direction === 'outbound' ? 'assistant' : 'user', text: r.text }));

  return { personaNotes, facts: factRows, contentHits, chunkHits, relations, digests, history };
}
