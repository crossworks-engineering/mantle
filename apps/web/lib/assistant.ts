/**
 * Web assistant — Sarah-on-the-web. One continuous conversation per owner
 * (no user-visible sessions). Shares the responder's memory model:
 * persona + facts + content_index + recent assistant turns. Digests are
 * deferred until web volume warrants them.
 *
 * Owns the read+write+LLM path end-to-end:
 *
 *   1. resolveAssistantAgent — highest-priority enabled `assistant` row;
 *      falls back to a `responder` if none configured (so a single agent
 *      can serve both surfaces).
 *   2. loadContext — facts + content_hits via vector search, persona_notes
 *      off the agent row, last N recent_turns from assistant_messages.
 *   3. INSERT the inbound row.
 *   4. buildChatMessages + OpenRouter chat → reply.
 *   5. INSERT the outbound row + bump agent usage.
 *
 * No tracing wired here yet — the existing tracing model is shaped around
 * the agent-runner process, not the Next request handler. Add a
 * 'assistant_turn' trace kind in a follow-up if cost/visibility matters.
 */

import { OpenRouter } from '@openrouter/sdk';
import { and, desc, eq, isNull, ne, or, sql } from 'drizzle-orm';
import {
  db,
  agents,
  assistantMessages,
  entities,
  facts,
  nodes,
  type Agent,
  type AgentMemoryConfig,
  type AgentParams,
  type AssistantMessage,
  type PersonaNote,
} from '@mantle/db';
import { getApiKeyById } from '@mantle/api-keys';
import { embed } from '@mantle/embeddings';
import {
  buildChatMessages,
  composeSystemPromptWithSkills,
  effectiveToolSlugs,
  invokeAgent,
  resolveAgentSkills,
  resolveAgentTools,
  runToolLoop,
  type ContentHit,
  type FactSnippet,
  type HistoryTurn,
} from '@mantle/agent-runtime';
import { registerAgentInvoker, type ToolArtifact } from '@mantle/tools';
import { stripAudioTags } from '@mantle/voice';
import { buildTimeContextLine, loadProfilePreferences } from '@mantle/content';
import { buildOpenHeartbeatContext, openHeartbeatsForSurface } from '@mantle/heartbeats';
import { startTrace } from '@mantle/tracing';

// Register the cross-package bridge for the `invoke_agent` builtin.
// First module load (the first /assistant request after boot) wires
// it up. Idempotent — last call wins.
registerAgentInvoker(invokeAgent);

export type AssistantTurnResult = {
  inbound: AssistantMessage;
  outbound: AssistantMessage;
  reply: string;
  /** Sidecar artifacts from worker tools (TTS audio, generated
   *  images). The /assistant page renders these inline in the reply
   *  bubble. Empty when no tools emitted any. */
  artifacts: ToolArtifact[];
};

/** Pick the best agent to handle a web turn. Prefers `assistant`-role rows;
 *  if none enabled, falls back to a `responder` so one persona can serve
 *  both surfaces with minimal setup. */
export async function resolveAssistantAgent(ownerId: string): Promise<Agent | null> {
  const [primary] = await db
    .select()
    .from(agents)
    .where(
      and(eq(agents.ownerId, ownerId), eq(agents.role, 'assistant'), eq(agents.enabled, true)),
    )
    .orderBy(desc(agents.priority))
    .limit(1);
  if (primary) return primary;
  const [fallback] = await db
    .select()
    .from(agents)
    .where(
      and(eq(agents.ownerId, ownerId), eq(agents.role, 'responder'), eq(agents.enabled, true)),
    )
    .orderBy(desc(agents.priority))
    .limit(1);
  return fallback ?? null;
}

async function loadContext(
  ownerId: string,
  agent: Agent,
  inboundText: string,
): Promise<{
  personaNotes: PersonaNote[];
  facts: FactSnippet[];
  contentHits: ContentHit[];
  history: HistoryTurn[];
}> {
  const memoryConfig = (agent.memoryConfig ?? {}) as AgentMemoryConfig;
  const historyLimit = memoryConfig.history_limit ?? 20;
  const factLimit = memoryConfig.fact_limit ?? 10;
  const contentHitLimit = memoryConfig.content_hit_limit ?? 3;
  const embeddingModel = memoryConfig.embedding_model;

  const personaNotes: PersonaNote[] = (agent.personaNotes ?? []) as PersonaNote[];

  // Embed the inbound once for both fact + content_index lookups.
  let queryVec: number[] | null = null;
  if ((factLimit > 0 || contentHitLimit > 0) && inboundText.trim().length > 0) {
    try {
      queryVec = await embed(
        ownerId,
        inboundText.slice(0, 2000),
        embeddingModel ? { model: embeddingModel } : undefined,
      );
    } catch (err) {
      console.error(
        '[assistant] query embed failed:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Facts: top-K by vector distance, currently-valid only.
  let factRows: FactSnippet[] = [];
  if (queryVec && factLimit > 0) {
    const rows = await db
      .select({
        content: facts.content,
        kind: facts.kind,
        entityName: entities.name,
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

  // content_index hits, same as the Telegram responder.
  let contentHits: ContentHit[] = [];
  if (queryVec && contentHitLimit > 0) {
    const rows = await db
      .select({
        nodeId: nodes.id,
        title: nodes.title,
        type: nodes.type,
        data: nodes.data,
      })
      .from(nodes)
      .where(
        and(
          eq(nodes.ownerId, ownerId),
          sql`${nodes.embedding} is not null`,
          sql`not (${nodes.tags} @> ARRAY['conversation-digest']::text[])`,
          sql`${nodes.type} <> 'telegram_message'`,
        ),
      )
      .orderBy(sql`${nodes.embedding} <=> ${JSON.stringify(queryVec)}::vector`)
      .limit(contentHitLimit);
    contentHits = rows.map((r) => {
      const data = (r.data ?? {}) as Record<string, unknown>;
      return {
        title: r.title,
        type: r.type,
        summary: typeof data.summary === 'string' ? data.summary : null,
        nodeId: r.nodeId,
      };
    });
  }

  // Recent assistant turns.
  const historyRows = await db
    .select({
      direction: assistantMessages.direction,
      text: assistantMessages.text,
      createdAt: assistantMessages.createdAt,
    })
    .from(assistantMessages)
    .where(eq(assistantMessages.ownerId, ownerId))
    .orderBy(desc(assistantMessages.createdAt))
    .limit(historyLimit);

  const history: HistoryTurn[] = historyRows
    .reverse()
    .map((r) => ({ role: r.direction === 'outbound' ? 'assistant' : 'user', text: r.text }));

  return { personaNotes, facts: factRows, contentHits, history };
}

/**
 * Run one user turn end-to-end. Persists inbound, calls the model,
 * persists outbound, returns both rows + the reply text.
 *
 * `text` is what the LLM sees. `displayText`, when provided, is what
 * the inbound row stores in the DB + what the client renders in the
 * user's bubble. They differ when a tool-side preprocessor injected
 * extra context — e.g. the /api/assistant/turn route appends a
 * vision-extracted transcript when an image is attached. The LLM
 * needs the transcript; the chat UI doesn't want the auto-injected
 * text duplicated in the user's bubble.
 *
 * Keeping the persisted row aligned with what the user actually
 * typed means historical context (loaded by future turns via
 * recentAssistantMessages) reflects what the user actually said. The
 * vision transcript already lands in /files via the upload path, so
 * the LLM can recover it via search_nodes if it's relevant later.
 */
export async function runAssistantTurn(
  ownerId: string,
  text: string,
  options?: { displayText?: string },
): Promise<AssistantTurnResult> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('runAssistantTurn: empty text');
  const displayText = options?.displayText?.trim() ?? trimmed;

  const agent = await resolveAssistantAgent(ownerId);
  if (!agent) {
    throw new Error(
      'No enabled assistant agent. Create one at /settings/agents (role=assistant or fallback responder).',
    );
  }
  if (!agent.apiKeyId) {
    throw new Error(`Agent '${agent.slug}' has no api_key_id set — edit at /settings/agents.`);
  }
  const apiKey = await getApiKeyById(agent.apiKeyId);
  if (!apiKey) {
    throw new Error(
      `api_key_id ${agent.apiKeyId} not found for agent '${agent.slug}' — was it deleted?`,
    );
  }

  // 1. Load context BEFORE the inbound insert so the history block
  //    doesn't contain the brand-new turn — it's already going to be
  //    sent to the LLM as `newUserText` in buildChatMessages, and
  //    duplicating it makes the model think the user said the same
  //    thing twice ("you sent that twice — testing the double-tap?").
  const ctx = await loadContext(ownerId, agent, trimmed);
  const filteredHistory = ctx.history;

  // 2. Persist inbound BEFORE the LLM call so the row survives a
  //    model error. The page can resume on reload. We store the
  //    USER-VISIBLE text (displayText) — not the LLM-augmented
  //    version — so the chat history stays clean. See the
  //    runAssistantTurn header for the rationale.
  const [inbound] = await db
    .insert(assistantMessages)
    .values({
      ownerId,
      direction: 'inbound',
      text: displayText,
    })
    .returning();
  if (!inbound) throw new Error('failed to insert inbound row');

  const attachedSkills = await resolveAgentSkills(ownerId, agent.skillSlugs ?? []);
  // Prepend the current-time / timezone / locale context so the
  // assistant can resolve relative time references in event_create
  // calls. Mirrors the apps/agent (Telegram) flow.
  const prefs = await loadProfilePreferences(ownerId);
  const promptWithTime = `${buildTimeContextLine(prefs)}\n\n${agent.systemPrompt}`;
  const promptWithSkills = composeSystemPromptWithSkills(promptWithTime, attachedSkills);

  // Open-heartbeat awareness: if the user has heartbeats whose
  // surface is the web /assistant and that are currently waiting
  // on a reply (state.expecting_reply truthy), append a small
  // awareness block. Same shape + builder as the Telegram path in
  // apps/agent — keeps the proactive→reactive continuity working
  // for web heartbeats too. Best-effort; a DB blip here shouldn't
  // kill the turn. (P0-3 in the v1 heartbeats audit.)
  //
  // `relatedHeartbeatSlugs` is captured here and threaded into the
  // startTrace data jsonb below, so /traces and the trace detail
  // page show "this responder turn was influenced by heartbeat X"
  // without needing a separate join. (Audit P-trace-5.)
  let openHeartbeatBlock = '';
  let relatedHeartbeatSlugs: string[] = [];
  try {
    const open = await openHeartbeatsForSurface(ownerId, { kind: 'web' });
    relatedHeartbeatSlugs = open.map((o) => o.slug);
    const block = buildOpenHeartbeatContext(open);
    if (block) openHeartbeatBlock = `\n\n${block}`;
  } catch (err) {
    console.error(
      '[assistant] open-heartbeat context skipped:',
      err instanceof Error ? err.message : err,
    );
  }
  const effectiveSystemPrompt = promptWithSkills + openHeartbeatBlock;
  // Heartbeat continuity tools are sourced from agent.tool_slugs
  // (not auto-injected here). Add them at /settings/agents on the
  // agent that should respond to heartbeat-asked questions.

  const messages = buildChatMessages({
    model: agent.model,
    systemPrompt: effectiveSystemPrompt,
    personaNotes: ctx.personaNotes,
    facts: ctx.facts,
    digests: [],
    contentHits: ctx.contentHits,
    history: filteredHistory,
    newUserText: trimmed,
  });

  const client = new OpenRouter({
    apiKey,
    httpReferer: 'https://mantle.crossworks.network',
    appTitle: 'Mantle',
  });

  const params = (agent.params ?? {}) as AgentParams;
  // Resolve the agent's tool allowlist, unioned with every attached
  // skill's tool_slugs. Empty result → tool-loop sends no `tools`
  // and the loop reduces to one LLM call (same as before).
  const allowedToolSlugs = effectiveToolSlugs(agent.toolSlugs ?? [], attachedSkills);
  const allowedTools = await resolveAgentTools(ownerId, allowedToolSlugs);

  // Wrap the tool loop in a trace so every LLM call + tool dispatch
  // gets persisted as a step. This is the Layer A treatment for the
  // web /assistant surface — previously turns ran silently and the
  // operator had no way to see whether Saskia actually called a tool
  // or just claimed she did. We reuse the existing 'responder_turn'
  // kind (no new enum value needed); subject_kind='assistant_message'
  // + subject_id=inbound.id ties the trace to the row the chat UI
  // shows. The node-biography page at /nodes/<id>/history works for
  // any subject_id — operators can use it on assistant_messages too,
  // though those rows don't show in /files (different table).
  const loopOutcome = await startTrace(
    {
      kind: 'responder_turn',
      ownerId,
      subjectId: inbound.id,
      subjectKind: 'assistant_message',
      agentId: agent.id,
      data: {
        surface: 'web',
        model: agent.model,
        agent_slug: agent.slug,
        tool_count: allowedTools.length,
        // Empty array when no heartbeats were open. Stored either
        // way so a query for "traces influenced by heartbeats"
        // works against the same shape on every row.
        related_heartbeat_slugs: relatedHeartbeatSlugs,
      },
    },
    async () =>
      runToolLoop({
        client,
        model: agent.model,
        params,
        ownerId,
        agentId: agent.id,
        agentSlug: agent.slug,
        agentDepth: 1,
        delegateTo: (agent.memoryConfig as { delegate_to?: string[] } | null)?.delegate_to ?? [],
        initialMessages: messages,
        tools: allowedTools,
        // /assistant has no outbound channel beyond the reply stream
        // itself — tools that want to "send a voice note" or similar
        // refuse here with a clean error so the LLM falls back to text.
        surface: { kind: 'web' },
      }),
  );
  const rawReply = loopOutcome.reply;
  if (!rawReply) {
    throw new Error('assistant: empty reply from model');
  }
  // Defensive strip — the web /assistant is text-only today, so any
  // audio tags Saskia emits (because she carried the habit over from
  // her Telegram persona) would render as literal brackets in the
  // chat bubble. If we ever add web TTS playback, this is the
  // branch point where voice-mode reply would skip the strip.
  const reply = stripAudioTags(rawReply).text;

  const [outbound] = await db
    .insert(assistantMessages)
    .values({
      ownerId,
      direction: 'outbound',
      text: reply,
      agentId: agent.id,
      model: agent.model,
    })
    .returning();
  if (!outbound) throw new Error('failed to insert outbound row');

  void db
    .update(agents)
    .set({
      lastUsedAt: new Date(),
      usageCount: (agent.usageCount ?? 0) + 1,
      updatedAt: new Date(),
    })
    .where(eq(agents.id, agent.id))
    .catch(() => {});

  return { inbound, outbound, reply, artifacts: loopOutcome.artifacts };
}

export type AssistantTimelineRow = {
  id: string;
  direction: 'inbound' | 'outbound';
  text: string;
  model: string | null;
  createdAt: string;
};

export async function recentAssistantMessages(
  ownerId: string,
  limit = 100,
): Promise<AssistantTimelineRow[]> {
  const rows = await db
    .select({
      id: assistantMessages.id,
      direction: assistantMessages.direction,
      text: assistantMessages.text,
      model: assistantMessages.model,
      createdAt: assistantMessages.createdAt,
    })
    .from(assistantMessages)
    .where(eq(assistantMessages.ownerId, ownerId))
    .orderBy(desc(assistantMessages.createdAt))
    .limit(limit);
  return rows
    .reverse()
    .map((r) => ({
      id: r.id,
      direction: r.direction as 'inbound' | 'outbound',
      text: r.text,
      model: r.model,
      createdAt: r.createdAt.toISOString(),
    }));
}

// Marks below silence "unused import" lint warnings when the runtime
// helpers are referenced indirectly.
void ne;
void or;
