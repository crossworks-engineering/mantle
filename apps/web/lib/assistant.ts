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

import { and, desc, eq, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
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
  buildAttachmentContextText,
  composeSystemPromptWithSkills,
  effectiveToolSlugs,
  invokeAgent,
  resolveAgentSkills,
  resolveAgentTools,
  resolveBackupAdapter,
  runToolLoop,
  type ContentHit,
  type FactSnippet,
  type HistoryTurn,
  type UserImage,
} from '@mantle/agent-runtime';
import { registerAgentInvoker, type ToolArtifact } from '@mantle/tools';
import { getChatAdapter, stripAudioTags } from '@mantle/voice';
import { buildTimeContextLine, loadProfilePreferences } from '@mantle/content';
import {
  buildOpenHeartbeatContext,
  HEARTBEAT_RESPONDER_TOOLS,
  hasActiveHeartbeatsOnSurface,
  openHeartbeatsForSurface,
} from '@mantle/heartbeats';
import { startTrace, modelSupportsVision, maxImageBytesFor, refreshModelCatalog } from '@mantle/tracing';

/** Decoded byte size of a base64 string (tolerates a leading data-URL
 *  prefix). Used to size-check an inline image before sending it to a
 *  vision responder, without allocating a Buffer. */
function base64Bytes(b64: string): number {
  const clean = b64.includes(',') ? b64.slice(b64.indexOf(',') + 1) : b64;
  const len = clean.length;
  if (len === 0) return 0;
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
}

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
export async function resolveAssistantAgent(
  ownerId: string,
  slug?: string,
): Promise<Agent | null> {
  // Explicit pick (the /assistant agent selector). Owner-scoped + enabled;
  // falls through to the default if the slug isn't valid.
  if (slug) {
    const [picked] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.ownerId, ownerId), eq(agents.slug, slug), eq(agents.enabled, true)))
      .limit(1);
    if (picked) return picked;
  }
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

  const personaNotes: PersonaNote[] = (agent.personaNotes ?? []) as PersonaNote[];

  // Embed the inbound once for both fact + content_index lookups. The embedder
  // is resolved centrally from embedding_config — no per-agent override.
  let queryVec: number[] | null = null;
  if ((factLimit > 0 || contentHitLimit > 0) && inboundText.trim().length > 0) {
    try {
      queryVec = await embed(ownerId, inboundText.slice(0, 2000));
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
    .where(
      and(
        eq(assistantMessages.ownerId, ownerId),
        eq(assistantMessages.agentId, agent.id),
      ),
    )
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
  options?: {
    displayText?: string;
    /** Whether the attachment is an image (vision) or a document (parsed
     *  text). Drives the injected marker's wording + which re-read tool the
     *  model is pointed at. Defaults to 'image'. */
    attachmentKind?: 'image' | 'file';
    /** Raw image bytes to show a vision-capable responder directly. Images
     *  only — documents have no inline form. */
    image?: UserImage;
    /** Extracted text for the attachment — a vision transcript for images,
     *  parsed text for documents. Preferred over the raw image: cheap,
     *  cacheable, and the worker already answered the user's question at
     *  ingest. Injected as text. */
    imageTranscript?: string;
    /** Note injected when the attachment couldn't be read at all. */
    imageNote?: string;
    /** File node id of the saved attachment, surfaced in the injected text so
     *  the model can re-read it (extract_from_image / file_read) on a
     *  follow-up. */
    imageNodeId?: string;
    /** Which agent answers this turn (the /assistant agent selector). Resolved
     *  owner-scoped + enabled; falls back to the default assistant. */
    agentSlug?: string;
  },
): Promise<AssistantTurnResult> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('runAssistantTurn: empty text');
  const displayText = options?.displayText?.trim() ?? trimmed;

  const agent = await resolveAssistantAgent(ownerId, options?.agentSlug);
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
      agentId: agent.id,
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

  // Image routing — transcript-default. The vision worker already described
  // (and, when the user asked a question, answered) the image at ingest, so
  // prefer its cheap, cacheable transcript as text. Only show the responder
  // the raw pixels when there's NO usable transcript (worker failed or
  // unconfigured) — and only if the model is vision-capable and the file is
  // within that provider's per-image limit. (Anthropic via OpenRouter →
  // Bedrock rejects oversized images with an opaque "Could not process
  // image" the SDK masks as a validation error; the size guard avoids it.)
  // Either way the node id is surfaced in the text so Saskia can pull the
  // picture back for a closer look via extract_from_image(node_id).
  // Warm the live model catalog so the vision check below reads authoritative
  // capability (architecture.input_modalities) rather than the heuristic.
  // Fire-and-forget + TTL-gated; the static fallback covers the cold path.
  if (options?.image) void refreshModelCatalog();
  const hasTranscript = !!options?.imageTranscript?.trim();
  const imageBytes = options?.image ? base64Bytes(options.image.base64) : 0;
  const withinImageLimit = imageBytes > 0 && imageBytes <= maxImageBytesFor(agent.model);
  const canSeeImage =
    !!options?.image &&
    !hasTranscript &&
    modelSupportsVision(agent.model) &&
    withinImageLimit;
  if (options?.image && !hasTranscript && modelSupportsVision(agent.model) && !withinImageLimit) {
    console.warn(
      `[assistant] no transcript and image ${imageBytes}B exceeds ${agent.model} limit ` +
        `(${maxImageBytesFor(agent.model)}B) — answering from the saved file node only`,
    );
  }
  const userImage = canSeeImage ? options!.image : undefined;

  // The user's text with the attachment's extracted text / note + node-id
  // folded in. Used whenever we're NOT showing the raw image (always, for
  // documents), and as the retry fallback below if the responder chokes on
  // the picture.
  const textWithTranscript = buildAttachmentContextText(trimmed, {
    kind: options?.attachmentKind ?? 'image',
    transcript: options?.imageTranscript,
    note: options?.imageNote,
    nodeId: options?.imageNodeId,
  });

  const buildMessages = (image: UserImage | undefined, userText: string) =>
    buildChatMessages({
      model: agent.model,
      provider: agent.provider,
      systemPrompt: effectiveSystemPrompt,
      personaNotes: ctx.personaNotes,
      facts: ctx.facts,
      digests: [],
      contentHits: ctx.contentHits,
      history: filteredHistory,
      newUserText: userText,
      userImage: image,
    });

  // Resolve the chat adapter for this agent's provider. Stored in
  // agents.provider (migration 0048); defaults to 'openrouter' for
  // rows that predate the column.
  const assistantAdapter = getChatAdapter(agent.provider);
  if (!assistantAdapter) {
    throw new Error(
      `web/assistant: no chat adapter registered for provider '${agent.provider}' (agent ${agent.slug})`,
    );
  }

  const params = (agent.params ?? {}) as AgentParams;
  // Resolve the agent's tool allowlist, unioned with every attached
  // skill's tool_slugs. Empty result → tool-loop sends no `tools`
  // and the loop reduces to one LLM call (same as before).
  let allowedToolSlugs = effectiveToolSlugs(agent.toolSlugs ?? [], attachedSkills);
  // Per-turn affordance hygiene: drop the heartbeat continuity tools
  // from the model's tool list when there are no active heartbeats
  // on this surface. The grant in agents.tool_slugs is unchanged —
  // this is purely runtime scoping, mirroring apps/agent/main.ts.
  // See docs/heartbeats.md §4 "Permission model & runtime hygiene".
  const hasHeartbeats = await hasActiveHeartbeatsOnSurface(ownerId, { kind: 'web' }).catch(() => false);
  if (!hasHeartbeats) {
    allowedToolSlugs = allowedToolSlugs.filter((s) => !HEARTBEAT_RESPONDER_TOOLS.includes(s));
  }
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
  const runLoop = (
    messages: ReturnType<typeof buildMessages>,
    dataExtra: Record<string, unknown> = {},
  ) =>
    startTrace(
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
          ...dataExtra,
        },
      },
      async () =>
        runToolLoop({
          adapter: assistantAdapter,
          apiKey,
          model: agent.model,
          baseUrl: agent.baseUrl,
          viaTailnet: agent.viaTailnet,
          backup: await resolveBackupAdapter(ownerId, agent),
          params,
          ownerId,
          agentId: agent.id,
          agentSlug: agent.slug,
          agentDepth: 1,
          delegateTo: (agent.memoryConfig as { delegate_to?: string[] } | null)?.delegate_to ?? [],
          resultHandling: agent.memoryConfig?.result_handling ?? null,
          initialMessages: messages,
          tools: allowedTools,
          // /assistant has no outbound channel beyond the reply stream
          // itself — tools that want to "send a voice note" or similar
          // refuse here with a clean error so the LLM falls back to text.
          surface: { kind: 'web' },
        }),
    );

  // Run the turn. When we attached a raw image and the responder errors —
  // e.g. Bedrock's "Could not process image" surfacing as the SDK's
  // ResponseValidationError — retry once WITHOUT the image, grounded in the
  // vision-worker transcript instead, so a turn never hard-fails on a
  // picture. The failed first attempt stays its own 'error' trace; the
  // retry is a separate 'success' trace flagged image_retry_after_error.
  let loopOutcome: Awaited<ReturnType<typeof runLoop>>;
  if (canSeeImage) {
    try {
      loopOutcome = await runLoop(buildMessages(userImage, trimmed), { image_attached: true });
    } catch (err) {
      console.warn(
        '[assistant] responder failed with image attached; retrying text-only:',
        err instanceof Error ? err.message : err,
      );
      loopOutcome = await runLoop(buildMessages(undefined, textWithTranscript), {
        image_attached: false,
        image_retry_after_error: true,
      });
    }
  } else {
    loopOutcome = await runLoop(buildMessages(undefined, textWithTranscript), {
      image_attached: false,
    });
  }
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

/**
 * Recent transcript for one (owner, agent) thread, chronological
 * (oldest → newest). `agentId` is required — there is no
 * cross-agent / "all messages" view: each agent owns its own
 * forever-thread. The shared brain (nodes/facts/entities) is what
 * agents have in common; the conversation is not.
 */
export async function recentAssistantMessages(
  ownerId: string,
  agentId: string,
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
    .where(
      and(eq(assistantMessages.ownerId, ownerId), eq(assistantMessages.agentId, agentId)),
    )
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

/**
 * Page of (owner, agent) thread messages OLDER than `before` (an ISO
 * timestamp), for scroll-up lazy loading. Same shape/order as
 * recentAssistantMessages (chronological, oldest→newest). Returns up to
 * `limit` rows; fewer than `limit` means the top of the thread is reached.
 */
export async function assistantMessagesBefore(
  ownerId: string,
  agentId: string,
  before: string,
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
    .where(
      and(
        eq(assistantMessages.ownerId, ownerId),
        eq(assistantMessages.agentId, agentId),
        lt(assistantMessages.createdAt, new Date(before)),
      ),
    )
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

export type AssistantAgentOption = {
  id: string;
  slug: string;
  name: string;
  role: string;
  model: string;
};

/** Roles that can hold a back-and-forth chat. The pipeline roles
 *  (extractor/summarizer/reflector) are one-shot trigger-fired workers with no
 *  conversational prompt or tool loop, so they're excluded from the selector —
 *  picking one would be a dead end. */
const CHATTABLE_ROLES: ('assistant' | 'responder' | 'custom')[] = [
  'assistant',
  'responder',
  'custom',
];

/** Enabled, chat-capable agents the /assistant selector can target. */
export async function listAssistantAgents(ownerId: string): Promise<AssistantAgentOption[]> {
  const rows = await db
    .select({
      id: agents.id,
      slug: agents.slug,
      name: agents.name,
      role: agents.role,
      model: agents.model,
    })
    .from(agents)
    .where(
      and(
        eq(agents.ownerId, ownerId),
        eq(agents.enabled, true),
        inArray(agents.role, CHATTABLE_ROLES),
      ),
    )
    .orderBy(desc(agents.priority));
  return rows.map((r) => ({ id: r.id, slug: r.slug, name: r.name, role: r.role as string, model: r.model }));
}

// Marks below silence "unused import" lint warnings when the runtime
// helpers are referenced indirectly.
void ne;
