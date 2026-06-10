/**
 * Web assistant — Sarah-on-the-web, the web doorway onto the unified
 * per-(owner, agent) conversation stream (docs/conversation.md). Shares the
 * responder's memory model AND its conversation store: every turn — web,
 * Telegram, future channels — lands in assistant_messages and is read back
 * here through the shared @mantle/agent-runtime conversation module.
 *
 * Owns the read+write+LLM path end-to-end:
 *
 *   1. resolveAssistantAgent — highest-priority enabled `assistant` row;
 *      falls back to a `responder` if none configured (so a single agent
 *      can serve both surfaces).
 *   2. loadConversationContext — persona + facts + content_hits + digests +
 *      last-N recent turns (all channels), via the shared module.
 *   3. recordTurn — persist the inbound row (channel='web').
 *   4. buildChatMessages + tool-loop chat → reply.
 *   5. recordTurn — persist the outbound row + bump agent usage.
 *
 * The turn runs inside a 'responder_turn' trace (startTrace below), so every
 * LLM call + tool dispatch is visible in /traces.
 */

import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import {
  db,
  agents,
  assistantMessages,
  type Agent,
  type AgentParams,
  type AssistantMessage,
  type ConversationAttachment,
} from '@mantle/db';
import { getApiKeyById } from '@mantle/api-keys';
import {
  buildChatMessages,
  buildAttachmentContextText,
  composeSystemPromptWithSkills,
  effectiveToolSlugs,
  invokeAgent,
  loadConversationContext,
  recordTurn,
  resolveAgentSkills,
  resolveAgentToolGroups,
  resolveAgentTools,
  resolveBackupAdapter,
  runToolLoop,
  type UserImage,
} from '@mantle/agent-runtime';
import { registerAgentInvoker, type ToolArtifact } from '@mantle/tools';
import { getChatAdapter, stripAudioTags } from '@mantle/voice';
import {
  buildIdentityContext,
  buildTimeContextLine,
  loadProfilePreferences,
} from '@mantle/content';
import {
  buildOpenHeartbeatContext,
  HEARTBEAT_RESPONDER_TOOLS,
  hasActiveHeartbeatsOnSurface,
  openHeartbeatsForSurface,
  registerHeartbeatTools,
} from '@mantle/heartbeats';
import { startTrace, modelSupportsVision, maxImageBytesFor, refreshModelCatalog } from '@mantle/tracing';
import { pickWebDefaultAgent } from './assistant-select';

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

// Register the heartbeat-control builtins in THIS (web/Next) process.
// The web responder runs its tool loop in-process and injects the
// heartbeat continuity tools (heartbeat_update_state/complete/snooze)
// as a per-turn affordance whenever a web-surface heartbeat is active
// (see hasActiveHeartbeatsOnSurface below). Those handlers live in
// @mantle/heartbeats and only enter the builtin registry via this call
// — apps/agent does the same at boot. Without it, the model would be
// offered the tools (their rows are seeded) but dispatch would fail
// with "builtin handler 'heartbeat_update_state' not registered in
// this process", silently breaking the web continuity flow. Idempotent.
registerHeartbeatTools();

export type AssistantTurnResult = {
  inbound: AssistantMessage;
  outbound: AssistantMessage;
  reply: string;
  /** Sidecar artifacts from worker tools (TTS audio, generated
   *  images). The /assistant page renders these inline in the reply
   *  bubble. Empty when no tools emitted any. */
  artifacts: ToolArtifact[];
};

/** Pick the best agent to handle a web turn. Priority-based among enabled
 *  chat-capable agents (role decoupled — docs/comms-channels.md §6): highest
 *  `priority` wins, then a soft assistant→responder→custom tiebreak, then slug
 *  for determinism (the tiebreak + pick live in `pickWebDefaultAgent`, unit-
 *  tested). An explicit `?agent=` slug still wins outright. */
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
  const candidates = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.ownerId, ownerId),
        eq(agents.enabled, true),
        inArray(agents.role, CHATTABLE_ROLES),
      ),
    );
  return pickWebDefaultAgent(candidates);
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
  const ctx = await loadConversationContext({ ownerId, agent, inboundText: trimmed });
  const filteredHistory = ctx.history;

  // 2. Persist inbound BEFORE the LLM call so the row survives a
  //    model error. The page can resume on reload. We store the
  //    USER-VISIBLE text (displayText) — not the LLM-augmented
  //    version — so the chat history stays clean. See the
  //    runAssistantTurn header for the rationale.
  // Attachment provenance, persisted on the turn (no bytes — the image/doc is
  // already saved as a file node; the nodeId lets a future /assistant render
  // re-fetch it). channel='web' since this surface is the web doorway.
  const inboundAttachments: ConversationAttachment[] =
    options?.image || options?.imageNodeId
      ? [
          {
            kind: (options?.attachmentKind ?? 'image') === 'file' ? 'document' : 'image',
            ...(options?.image?.mimeType ? { mime: options.image.mimeType } : {}),
            ...(options?.imageNodeId ? { nodeId: options.imageNodeId } : {}),
          },
        ]
      : [];
  const inbound = await recordTurn({
    ownerId,
    agentId: agent.id,
    direction: 'inbound',
    text: displayText,
    channel: 'web',
    attachments: inboundAttachments,
  });

  const attachedSkills = await resolveAgentSkills(ownerId, agent.skillSlugs ?? []);
  // Current-time / timezone / locale context so the assistant can resolve
  // relative time references in event_create calls. Carries a per-turn
  // millisecond timestamp, so it rides in the uncached volatile block —
  // prepending it to the system prompt put it inside cache breakpoint 1
  // and busted the persona prefix every turn (2026-06 chat-cost audit).
  // Mirrors the apps/agent (Telegram) flow.
  const prefs = await loadProfilePreferences(ownerId);
  const timeContextLine = buildTimeContextLine(prefs);
  const promptWithSkills = composeSystemPromptWithSkills(agent.systemPrompt, attachedSkills);

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
  // Always-on identity context — the "who you are" block distilled from the
  // user's Life Logs (deterministic, no LLM; empty when there are none). Opt
  // out per-agent with memory_config.inject_lifelog=false. Prepended so it
  // reads as durable user-truth at the top of the (cached) system block.
  let identityBlock = '';
  if ((agent.memoryConfig as { inject_lifelog?: boolean } | null)?.inject_lifelog !== false) {
    try {
      const block = await buildIdentityContext(ownerId);
      if (block) identityBlock = `${block}\n\n`;
    } catch (err) {
      console.error(
        '[assistant] identity context skipped:',
        err instanceof Error ? err.message : err,
      );
    }
  }
  // Cached prefix (breakpoint 1): identity + persona + skills — stable
  // across turns. The time line and the heartbeat block ("asked Nmin
  // ago" churns) go to the uncached volatile slot instead.
  const effectiveSystemPrompt = identityBlock + promptWithSkills;
  const volatileContext = [timeContextLine, openHeartbeatBlock.trim()]
    .filter(Boolean)
    .join('\n\n');
  // Heartbeat continuity tools are injected below as a per-turn affordance
  // (P6) when there's an active heartbeat on this surface — not a stored grant.

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
      volatileContext,
      personaNotes: ctx.personaNotes,
      facts: ctx.facts,
      digests: ctx.digests,
      contentHits: ctx.contentHits,
      chunkHits: ctx.chunkHits,
      relations: ctx.relations,
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
  // Resolve the agent's tool allowlist from its granted tool groups (P6: groups
  // are the sole grant). Empty result → tool-loop sends no `tools` and the loop
  // reduces to one LLM call.
  const groupTools = await resolveAgentToolGroups(ownerId, agent.toolGroupSlugs ?? []);
  let allowedToolSlugs = effectiveToolSlugs(groupTools);
  // Heartbeat continuity tools are a per-turn AFFORDANCE (P6), not a stored
  // grant: inject them only when there's an active heartbeat on this surface
  // for the model to act on. Mirrors apps/agent/main.ts. See docs/heartbeats.md
  // §4 "Permission model & runtime hygiene".
  const hasHeartbeats = await hasActiveHeartbeatsOnSurface(ownerId, { kind: 'web' }).catch(() => false);
  if (hasHeartbeats) {
    allowedToolSlugs = [
      ...allowedToolSlugs,
      ...HEARTBEAT_RESPONDER_TOOLS.filter((s) => !allowedToolSlugs.includes(s)),
    ];
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

  const outbound = await recordTurn({
    ownerId,
    agentId: agent.id,
    direction: 'outbound',
    text: reply,
    channel: 'web',
    model: agent.model,
  });

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
  /** Transport the turn arrived/left on — drives the channel badge in the UI.
   *  'web' for native /assistant turns; 'telegram' (etc.) for turns that came
   *  in on another surface and now show in the unified stream. */
  channel: string;
  /** Persisted media (images, voice notes, docs) so the turn renders its
   *  attachments on load — no bytes, just node/file references. */
  attachments: ConversationAttachment[];
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
      channel: assistantMessages.channel,
      attachments: assistantMessages.attachments,
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
      channel: r.channel,
      attachments: r.attachments ?? [],
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
      channel: assistantMessages.channel,
      attachments: assistantMessages.attachments,
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
      channel: r.channel,
      attachments: r.attachments ?? [],
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
