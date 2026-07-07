/**
 * Assistant turn execution — the shared read+write+LLM path for one
 * conversational turn on the unified per-(owner, agent) stream
 * (docs/conversation.md). Originally "Sarah-on-the-web" in apps/web; lifted
 * here so it can run OUTSIDE the Next.js request — from a durable server-side
 * runner (apps/api) as well as the web route — without a turn dying when the
 * user navigates away. Every turn (web, mobile, future channels) lands in
 * assistant_messages and is read back through the shared @mantle/agent-runtime
 * conversation module.
 *
 * Owns the path end-to-end:
 *
 *   1. resolveAssistantAgent — highest-priority enabled chat-capable agent.
 *   2. loadConversationContext — persona + facts + content_hits + digests +
 *      last-N recent turns (all channels), via the shared module.
 *   3. recordTurn — persist the inbound row.
 *   4. buildChatMessages + tool-loop chat → reply.
 *   5. recordTurn — persist the outbound row + bump agent usage.
 *
 * The turn runs inside a 'responder_turn' trace (startTrace below), so every
 * LLM call + tool dispatch is visible in /traces.
 */

import { and, eq, inArray } from 'drizzle-orm';
import {
  db,
  agents,
  type Agent,
  type AgentParams,
  type AssistantMessage,
  type ConversationAttachment,
  type ConversationChannel,
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
  summarizeToolOutcomes,
  updateAssistantMessageOutcome,
  type UserImage,
} from '@mantle/agent-runtime';
import { registerAgentInvoker, type ToolArtifact } from '@mantle/tools';
import { getChatAdapter, stripAudioTags } from '@mantle/voice';
import {
  buildIdentityContext,
  buildLocationContextLine,
  buildTimeContextLine,
  loadProfilePreferences,
  isStreamThoughtsEnabled,
  isPersistThoughtsEnabled,
  resolveThinkingBudget,
  noteInboundChannel,
  applyAutoTimezone,
  type LocationPing,
} from '@mantle/content';
import { stageLabelForStep } from './stage-label';
import {
  buildOpenHeartbeatContext,
  HEARTBEAT_RESPONDER_TOOLS,
  hasActiveHeartbeatsOnSurface,
  openHeartbeatsForSurface,
  registerHeartbeatTools,
} from '@mantle/heartbeats';
import {
  startTrace,
  step,
  runDurableStep,
  emitTurnLifecycle,
  registerTurnAbort,
  unregisterTurnAbort,
  modelSupportsVision,
  maxImageBytesFor,
  refreshModelCatalog,
} from '@mantle/tracing';
import { pickWebDefaultAgent } from './select';

/** Rebuild the persistable thought trail from a turn's tool calls — the same
 *  grounded action labels the live trail shows (search/write/delegate), via the
 *  shared `stageLabelForStep`. Thinking rounds aren't tool calls, so the result
 *  is exactly the "real actions" set the record displays. Returns [] when no
 *  call maps to a recognised stage. */
function buildPersistedTrail(
  toolCalls: ReadonlyArray<{ slug: string; argsJson: string; durationMs: number }>,
): Array<{ kind: string; label: string; elapsedMs?: number }> {
  const out: Array<{ kind: string; label: string; elapsedMs?: number }> = [];
  toolCalls.forEach((tc, i) => {
    let parsed: Record<string, unknown> = {};
    try {
      const p = JSON.parse(tc.argsJson) as unknown;
      if (p && typeof p === 'object') parsed = p as Record<string, unknown>;
    } catch {
      /* unparseable args — the label just won't be enriched */
    }
    const stage = stageLabelForStep(`tool: ${tc.slug}`, { args: parsed }, i);
    if (stage && stage.kind !== 'thinking') {
      out.push({ kind: stage.kind, label: stage.label, elapsedMs: tc.durationMs });
    }
  });
  return out;
}

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
// First module load wires it up. Idempotent — last call wins.
registerAgentInvoker(invokeAgent);

// Register the heartbeat-control builtins in THIS process. The assistant
// responder runs its tool loop in-process and injects the heartbeat continuity
// tools (heartbeat_update_state/complete/snooze) as a per-turn affordance
// whenever a web-surface heartbeat is active (see hasActiveHeartbeatsOnSurface
// below). Those handlers live in @mantle/heartbeats and only enter the builtin
// registry via this call — apps/agent does the same at boot. Without it, the
// model would be offered the tools (their rows are seeded) but dispatch would
// fail with "builtin handler 'heartbeat_update_state' not registered in this
// process", silently breaking the continuity flow. Idempotent.
registerHeartbeatTools();

/** Roles that can hold a back-and-forth chat. The pipeline roles
 *  (extractor/summarizer/reflector) are one-shot trigger-fired workers with no
 *  conversational prompt or tool loop, so they're excluded — picking one would
 *  be a dead end. */
export const CHATTABLE_ROLES: ('assistant' | 'responder' | 'custom')[] = [
  'assistant',
  'responder',
  'custom',
];

export type AssistantTurnResult = {
  inbound: AssistantMessage;
  outbound: AssistantMessage;
  reply: string;
  /** Sidecar artifacts from worker tools (TTS audio, generated
   *  images). The /assistant page renders these inline in the reply
   *  bubble. Empty when no tools emitted any. */
  artifacts: ToolArtifact[];
};

/** Pick the best agent to handle a turn. Priority-based among enabled
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
/** Options for {@link runAssistantTurn}. All fields are plain serializable data
 *  so the durable apps/api runner can carry them as a workflow input. */
export type RunAssistantTurnOptions = {
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
  /** The attachment's original filename — lets the injected marker route a
   *  SPREADSHEET (.xlsx/.xls/.csv) to the Tables path (auto-imported on
   *  ingest) instead of the page-import hint. */
  imageFilename?: string;
  /** Which agent answers this turn (the /assistant agent selector). Resolved
   *  owner-scoped + enabled; falls back to the default assistant. */
  agentSlug?: string;
  /** Device location attached to this turn by the companion app. Persisted on
   *  the inbound row (`data.location`) and rendered into the volatile context
   *  so the agent is location-aware. Sanitized by the caller (the route). */
  location?: LocationPing;
  /** Surface this turn arrived on — 'web' (browser) or 'mobile' (companion
   *  app), derived from the request's auth. Tags both the inbound and outbound
   *  rows so proactive delivery can follow the last channel used. Defaults to
   *  'web'. */
  channel?: ConversationChannel;
  /** Client-minted per-turn correlation id (the same uuid sent as the request's
   *  Idempotency-Key). When set, this turn's trace steps are published as live
   *  `status`/token events keyed by it, so the client can narrate the turn as it
   *  runs (see docs/live-turn-streaming.md). Omit → no live stream; the poll
   *  fallback still works. */
  streamId?: string;
};

export async function runAssistantTurn(
  ownerId: string,
  text: string,
  options?: RunAssistantTurnOptions,
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
  const channel: ConversationChannel = options?.channel ?? 'web';
  // Journaled under the durable runner so a crash-resume doesn't insert a
  // duplicate inbound row (pure passthrough outside a workflow).
  const inbound = await runDurableStep('record_inbound', () =>
    recordTurn({
      ownerId,
      agentId: agent.id,
      direction: 'inbound',
      text: displayText,
      channel,
      attachments: inboundAttachments,
      ...(options?.location ? { data: { location: options.location } } : {}),
    }),
  );
  // Remember the surface this turn came in on so proactive delivery (reminders)
  // follows the last channel the user actually used. Best-effort — a failure
  // here must never sink the turn. Only mobile/telegram are reminder-capable;
  // noteInboundChannel no-ops for web (a browser can't receive a push).
  void noteInboundChannel(ownerId, channel);

  // Insert the OUTBOUND row 'pending' (empty text) right now — before the LLM
  // runs — so the turn has a stable durable id from the very start. This is the
  // durable "thinking…" bubble: a client (or a reload mid-turn) can bind to it,
  // it survives navigation, and the non-blocking route reconciles to it on
  // 'done'. Finalized below to 'complete' (text filled) or 'failed' (error set).
  // History loading filters status='complete', so this empty row never leaks
  // into a later turn's prompt. Journaled so a crash-resume reuses the same id.
  const outboundPending = await runDurableStep('record_outbound_pending', () =>
    recordTurn({
      ownerId,
      agentId: agent.id,
      direction: 'outbound',
      text: '',
      channel,
      model: agent.model,
      status: 'pending',
    }),
  );
  // turn-start: both durable rows now exist. Carries their ids so the client can
  // swap its optimistic bubbles for the canonical rows without waiting on the
  // POST. No-op unless this turn is streamed (streamId set) AND the runner has
  // installed the lifecycle observer. See docs/live-turn-streaming.md §6.
  if (options?.streamId) {
    emitTurnLifecycle(options.streamId, ownerId, 'turn-start', {
      agentSlug: agent.slug,
      model: agent.model,
      inboundId: inbound.id,
      outboundId: outboundPending.id,
    });
  }

  // Register a per-turn AbortController so a user Stop (NOTIFY → the runner's
  // cancel listener → abortTurn) can halt this turn's LLM generation. The tool
  // loop reads the signal via currentTurnAbortSignal(); we inspect
  // `.signal.aborted` after the loop to tell a stop from a real error. Retired at
  // every exit below (success + the catch). No streamId ⇒ no stop affordance.
  const abortController = options?.streamId ? registerTurnAbort(options.streamId, ownerId) : null;
  const retireAbort = () => {
    if (options?.streamId) unregisterTurnAbort(options.streamId);
  };

  const attachedSkills = await resolveAgentSkills(ownerId, agent.skillSlugs ?? []);
  // Current-time / timezone / locale context so the assistant can resolve
  // relative time references in event_create calls. Carries a per-turn
  // millisecond timestamp, so it rides in the uncached volatile block —
  // prepending it to the system prompt put it inside cache breakpoint 1
  // and busted the persona prefix every turn (2026-06 chat-cost audit).
  // Mirrors the apps/agent (Telegram) flow.
  let prefs = await loadProfilePreferences(ownerId);
  // Auto-set the timezone from a trustworthy device location (mobile always;
  // web when the fix isn't an IP/VPN fallback) so the time line below is right
  // for where the user actually is. Best-effort — a failure here must not sink
  // the turn. When it switches, we tell the agent so it mentions it + offers to
  // revert (the change also moves scheduling/reminders, so it's never silent).
  let timezoneSwitch: { timezone: string; previous: string } | undefined;
  if (options?.location) {
    try {
      const res = await applyAutoTimezone(ownerId, options.location, prefs);
      prefs = res.prefs;
      timezoneSwitch = res.switched;
    } catch (err) {
      console.error(
        '[assistant] auto-timezone skipped:',
        err instanceof Error ? err.message : err,
      );
    }
  }
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
  // user's Journal (deterministic, no LLM; empty when there are none). Opt
  // out per-agent with memory_config.inject_journal=false. Prepended so it
  // reads as durable user-truth at the top of the (cached) system block.
  let identityBlock = '';
  if ((agent.memoryConfig as { inject_journal?: boolean } | null)?.inject_journal !== false) {
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
  // Device location (when the companion app sent it) rides the uncached volatile
  // slot beside the time line — it's per-turn and changes constantly, so it must
  // never enter the cached persona prefix. The location_awareness skill teaches
  // the agent how to act on it.
  const locationContextLine = buildLocationContextLine(options?.location ?? null);
  // When the timezone auto-switched this turn, tell the agent so it surfaces the
  // change to the user (and can offer to switch it back) rather than it happening
  // invisibly behind a persistent setting.
  const timezoneSwitchNote = timezoneSwitch
    ? `Note: the user's timezone was just auto-updated to ${timezoneSwitch.timezone} ` +
      `(was ${timezoneSwitch.previous}) based on their current location. Briefly let them ` +
      `know you've done this, and offer to switch it back when they're home.`
    : '';
  const volatileContext = [
    timeContextLine,
    locationContextLine,
    timezoneSwitchNote,
    openHeartbeatBlock.trim(),
  ]
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
    filename: options?.imageFilename,
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
        // When the client minted a stream id, key this turn's live status/token
        // events on it (no-op when absent — the trace just isn't streamed).
        turnId: options?.streamId,
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
      async () => {
        // Persist the retrieval snapshot as a 'load_context' step — the same
        // shape the Telegram responder records — so /debug/context can show
        // what this turn's question retrieved (items, distances, near-misses).
        // Context was loaded BEFORE the trace opened (step 1 above: history
        // must not contain the new turn), so this step only records it.
        await step(
          { name: 'load_context', kind: 'compute', input: { agentId: agent.id } },
          async (h) => {
            h.setOutput({
              turnCount: ctx.history.length,
              factCount: ctx.facts.length,
              contentHitCount: ctx.contentHits.length,
              chunkHitCount: ctx.chunkHits.length,
              relationCount: ctx.relations.length,
              snapshot: ctx.snapshot,
            });
          },
        );
        return runToolLoop({
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
          // Per-user adaptive thinking: gated by the live-thinking switch AND a
          // positive budget (reuse the already-loaded prefs). 0 ⇒ no thinking.
          thinkingBudget: resolveThinkingBudget(prefs),
          // Honor the agent's per-turn iteration override for the TOP-LEVEL
          // responder turn too (not just delegated children). A heavy
          // gather-then-author task needs more than the runtime default of 6
          // rounds or the loop force_finals mid-read and never authors. Clamp
          // matches invoke-agent: positive ints only, hard-capped at 30.
          // The tool-volume overrides (max_tool_calls / max_calls_per_tool)
          // travel raw — runToolLoop validates + clamps them itself.
          ...(() => {
            const mc = agent.memoryConfig as {
              max_iterations?: number;
              max_tool_calls?: number;
              max_calls_per_tool?: number;
            } | null;
            const requested = mc?.max_iterations;
            return {
              ...(typeof requested === 'number' && requested > 0
                ? { maxIterations: Math.min(30, Math.floor(requested)) }
                : {}),
              ...(typeof mc?.max_tool_calls === 'number'
                ? { maxToolCallsPerTurn: mc.max_tool_calls }
                : {}),
              ...(typeof mc?.max_calls_per_tool === 'number'
                ? { maxCallsPerToolPerTurn: mc.max_calls_per_tool }
                : {}),
            };
          })(),
          initialMessages: messages,
          tools: allowedTools,
          // /assistant has no outbound channel beyond the reply stream
          // itself — tools that want to "send a voice note" or similar
          // refuse here with a clean error so the LLM falls back to text.
          surface: { kind: 'web' },
        });
      },
    );

  // Run the turn. When we attached a raw image and the responder errors —
  // e.g. Bedrock's "Could not process image" surfacing as the SDK's
  // ResponseValidationError — retry once WITHOUT the image, grounded in the
  // vision-worker transcript instead, so a turn never hard-fails on a
  // picture. The failed first attempt stays its own 'error' trace; the
  // retry is a separate 'success' trace flagged image_retry_after_error.
  let loopOutcome: Awaited<ReturnType<typeof runLoop>>;
  try {
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
  } catch (err) {
    // A user Stop normally surfaces gracefully (the streaming adapter returns its
    // partial reply → the success path), but the one-shot/backup path can throw
    // an AbortError instead. If this turn was aborted, treat it as a stop, not a
    // failure: synthesize an empty outcome and let the success path finalize the
    // (possibly partial-less) turn 'complete'.
    if (abortController?.signal.aborted) {
      loopOutcome = { reply: '', artifacts: [], iterations: 0, toolCalls: [], tokensOut: 0 } as unknown as Awaited<
        ReturnType<typeof runLoop>
      >;
    } else {
      // Real failure: flip the pending outbound row to 'failed' so the durable
      // record + a reload + the non-blocking client all reflect it, emit the
      // terminal error event, then re-throw — the workflow lands in ERROR and the
      // blocking route's getResult() still rejects (unchanged failure surface).
      const msg = err instanceof Error ? err.message : String(err);
      await runDurableStep('fail_outbound', () =>
        updateAssistantMessageOutcome({
          ownerId,
          id: outboundPending.id,
          status: 'failed',
          error: msg,
        }),
      ).catch((e) => console.error('[assistant] could not mark turn failed:', e));
      if (options?.streamId) {
        emitTurnLifecycle(options.streamId, ownerId, 'error', { message: msg });
      }
      retireAbort();
      throw err;
    }
  }
  // A user Stop ends the turn with whatever partial reply streamed (often empty).
  const stopped = abortController?.signal.aborted === true;
  let rawReply = loopOutcome.reply;
  if (!stopped && !rawReply.trim()) {
    // The tool loop already retried an empty final response once (see
    // retryEmptyReply in tool-loop.ts). Double-empty is rare enough that
    // failing the whole turn (a 500 after the inbound row persisted) is
    // worse than an honest fallback the user can react to.
    console.error(
      `[assistant] empty reply from model after retry (agent ${agent.slug}, ` +
        `${loopOutcome.iterations} iterations, ${loopOutcome.toolCalls.length} tool calls) — ` +
        'substituting fallback reply',
    );
    rawReply =
      "Sorry — I gathered some information but couldn't compose a final answer " +
      '(the model returned an empty response twice). Please ask that again, ' +
      'perhaps more narrowly.';
  }
  // Defensive strip — the web /assistant is text-only today, so any
  // audio tags Saskia emits (because she carried the habit over from
  // her Telegram persona) would render as literal brackets in the
  // chat bubble. If we ever add web TTS playback, this is the
  // branch point where voice-mode reply would skip the strip.
  const reply = stripAudioTags(rawReply).text;

  // Finalize the pending outbound row: fill the composed reply + flip the status
  // to 'complete'. Journaled, so a crash-resume re-applies it idempotently.
  // Persist the thought trail (grounded action labels rebuilt from this turn's
  // tool calls) onto the row so the record survives a reload — only when the
  // brain has live streaming AND persistence on (Settings → Profile). A turn
  // with no recognised actions persists nothing (no empty record).
  const persistedThoughts =
    isStreamThoughtsEnabled(prefs) && isPersistThoughtsEnabled(prefs)
      ? buildPersistedTrail(loopOutcome.toolCalls)
      : [];
  // Deterministic tool-outcome ledger for the turn — persisted whenever any
  // tool ran, independent of the thoughts-persistence preference: it's what
  // the UI footer shows so "12 calls, 2 failed" is the runtime's account,
  // not the reply's.
  const toolStats =
    loopOutcome.toolCalls.length > 0 ? summarizeToolOutcomes(loopOutcome.toolCalls) : null;
  const finalized = await runDurableStep('finalize_outbound', () =>
    updateAssistantMessageOutcome({
      ownerId,
      id: outboundPending.id,
      status: 'complete',
      text: reply,
      model: agent.model,
      ...(persistedThoughts.length ? { thoughts: persistedThoughts } : {}),
      ...(toolStats ? { toolStats } : {}),
    }),
  );
  // The row was inserted this same turn, so it should always still be there;
  // fall back to the pending row with the reply folded in if it somehow vanished
  // (e.g. a concurrent delete) so the turn still returns a coherent result.
  const outbound: AssistantMessage =
    finalized ?? { ...outboundPending, text: reply, model: agent.model, status: 'complete' };

  void db
    .update(agents)
    .set({
      lastUsedAt: new Date(),
      usageCount: (agent.usageCount ?? 0) + 1,
      updatedAt: new Date(),
    })
    .where(eq(agents.id, agent.id))
    .catch(() => {});

  // done: the durable outbound row is final — the client reconciles to it (the
  // streamed buffer was advisory). A stopped turn finalizes the same way (its
  // partial reply is the durable answer), so the client ends the turn cleanly.
  // No-op unless the turn is streamed.
  retireAbort();
  if (options?.streamId) {
    emitTurnLifecycle(options.streamId, ownerId, 'done', {
      outboundId: outboundPending.id,
      // Real output-token total for the turn — the client swaps its streamed
      // estimate for this once `done` lands (0 when no provider reported usage).
      tokensOut: loopOutcome.tokensOut,
    });
  }

  return { inbound, outbound, reply, artifacts: loopOutcome.artifacts };
}
