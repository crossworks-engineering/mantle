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
import type { ContentHit, Digest, FactSnippet, HistoryTurn } from './messages';

void agents; // referenced for the Agent type's provenance; silence unused-import lint.

/** Either the pooled `db` or an open transaction handle, so a caller can fold a
 *  conversation turn into a larger atomic write (the Telegram dual-write in
 *  Phase 3 writes telegram_messages + the conversation row in one transaction). */
type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type ConversationContext = {
  personaNotes: PersonaNote[];
  facts: FactSnippet[];
  contentHits: ContentHit[];
  digests: Digest[];
  history: HistoryTurn[];
};

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

  const personaNotes: PersonaNote[] = (agent.personaNotes ?? []) as PersonaNote[];

  // Embed the inbound once for both fact + content lookups. The embedder is
  // resolved centrally from embedding_config — no per-agent override (the query
  // must share the corpus's vector space).
  let queryVec: number[] | null = null;
  if ((factLimit > 0 || contentHitLimit > 0) && inboundText.trim().length > 0) {
    try {
      queryVec = await embed(ownerId, inboundText.slice(0, 2000));
    } catch (err) {
      console.error(
        '[conversation] query embed failed:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ─── Profile facts (top-K by vector distance, currently-valid) ──────────
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
    factRows = rows
      // Mismatch guard: if the query vector and stored fact vectors live in
      // different embedding-model spaces, cosine distances cluster near 1.0.
      // Drop those so a mismatch degrades to "no facts" (visible) rather than
      // surfacing garbage-space rows. Loose by design (0.85) — legitimate facts
      // still pass even when only loosely related.
      .filter((r) => (r.dist ?? 1) < 0.85)
      .map((r) => ({ content: r.content, kind: r.kind as string, entityName: r.entityName }));
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
      .orderBy(
        sql`(${nodes.embedding} <=> ${JSON.stringify(queryVec)}::vector) + ${SALIENCE_LAMBDA} * (1 - ${nodes.salience})`,
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

  return { personaNotes, facts: factRows, contentHits, digests, history };
}
