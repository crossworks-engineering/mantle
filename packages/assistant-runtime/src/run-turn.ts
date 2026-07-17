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
  type AssistantMessage,
  type ConversationAttachment,
  type ConversationChannel,
} from '@mantle/db';
import { getApiKeyById } from '@mantle/api-keys';
import {
  buildChatMessages,
  buildAttachmentContextText,
  invokeAgent,
  loadConversationContext,
  recordTurn,
  updateAssistantMessageOutcome,
  type UserImage,
} from '@mantle/agent-runtime';
import { registerAgentInvoker, type ToolArtifact } from '@mantle/tools';
import { getChatAdapter, stripAudioTags } from '@mantle/voice';
import {
  buildLocationContextLine,
  loadProfilePreferences,
  noteInboundChannel,
  applyAutoTimezone,
  type LocationPing,
} from '@mantle/content';
import { registerHeartbeatTools } from '@mantle/heartbeats';
import {
  startTrace,
  runDurableStep,
  emitTurnLifecycle,
  registerTurnAbort,
  unregisterTurnAbort,
} from '@mantle/tracing';
import { pickWebDefaultAgent } from './select';
import {
  assembleResponderTurn,
  base64Bytes,
  decideImageRouting,
  runWithImageFallback,
} from './assemble-turn';
import { emptyLoopResult, runResponderLoop, type ResponderLoopResult } from './responder-loop';

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
export async function resolveAssistantAgent(ownerId: string, slug?: string): Promise<Agent | null> {
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
      console.error('[assistant] auto-timezone skipped:', err instanceof Error ? err.message : err);
    }
  }
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

  // Shared responder-turn assembly (audit #5c): identity + skills prompt,
  // volatile context (time line + the two web extras above + open-heartbeat
  // awareness), tool allowlist + heartbeat affordance, thinking budget, loop
  // overrides. `relatedHeartbeatSlugs` is threaded into the startTrace data
  // jsonb below, so /traces shows "this responder turn was influenced by
  // heartbeat X" without needing a separate join. (Audit P-trace-5.)
  const assembled = await assembleResponderTurn({
    ownerId,
    agent,
    prefs,
    logPrefix: '[assistant]',
    volatileExtras: [locationContextLine, timezoneSwitchNote],
    heartbeatSurface: { kind: 'web' },
  });
  const { effectiveSystemPrompt, volatileContext, relatedHeartbeatSlugs, allowedTools } = assembled;

  // Image routing — transcript-default vision gating via the shared
  // `decideImageRouting` (catalog warm + vision + per-provider size check).
  // Either way the node id is surfaced in the text so Saskia can pull the
  // picture back for a closer look via extract_from_image(node_id).
  const canSeeImage = decideImageRouting({
    model: agent.model,
    hasImage: !!options?.image,
    imageBytes: options?.image ? base64Bytes(options.image.base64) : 0,
    hasTranscript: !!options?.imageTranscript?.trim(),
    logPrefix: '[assistant]',
  });
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

  // Resolve the chat adapter for this agent's provider. Stored in
  // agents.provider (migration 0048); defaults to 'openrouter' for
  // rows that predate the column.
  const assistantAdapter = getChatAdapter(agent.provider);
  if (!assistantAdapter) {
    throw new Error(
      `web/assistant: no chat adapter registered for provider '${agent.provider}' (agent ${agent.slug})`,
    );
  }

  // Wrap the shared loop core in a trace so every LLM call + tool dispatch
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
    image: UserImage | undefined,
    userText: string,
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
      () =>
        runResponderLoop({
          ownerId,
          agent,
          adapter: assistantAdapter,
          apiKey,
          prefs,
          logPrefix: '[assistant]',
          assembled,
          // Context was loaded BEFORE the trace opened (step 1 above: history
          // must not contain the new turn) — the core's load_context step
          // just records the snapshot for /debug/context.
          loadContext: async () => ctx,
          buildMessages: (c) =>
            buildChatMessages({
              model: agent.model,
              provider: agent.provider,
              systemPrompt: effectiveSystemPrompt,
              volatileContext,
              personaNotes: c.personaNotes,
              facts: c.facts,
              digests: c.digests,
              corpusMap: c.corpusMap,
              contentHits: c.contentHits,
              chunkHits: c.chunkHits,
              relations: c.relations,
              history: filteredHistory,
              newUserText: userText,
              userImage: image,
            }),
          // /assistant has no outbound channel beyond the reply stream
          // itself — tools that want to "send a voice note" or similar
          // refuse here with a clean error so the LLM falls back to text.
          surface: { kind: 'web' },
          abortSignal: abortController?.signal ?? null,
        }),
    );

  // Run the turn via the shared image-fallback wrapper: when we attached a
  // raw image and the responder errors — e.g. Bedrock's "Could not process
  // image" surfacing as the SDK's ResponseValidationError — retry once
  // WITHOUT the image, grounded in the vision-worker transcript instead, so a
  // turn never hard-fails on a picture. The failed first attempt stays its
  // own 'error' trace; the retry is a separate 'success' trace flagged
  // image_retry_after_error.
  let outcome: ResponderLoopResult;
  try {
    outcome = await runWithImageFallback({
      canSeeImage,
      logPrefix: '[assistant]',
      withImage: () => runLoop(userImage, trimmed, { image_attached: true }),
      textOnly: (retryAfterImageError) =>
        runLoop(undefined, textWithTranscript, {
          image_attached: false,
          ...(retryAfterImageError ? { image_retry_after_error: true } : {}),
        }),
    });
  } catch (err) {
    // A user Stop normally surfaces gracefully (the streaming adapter returns its
    // partial reply → the success path), but the one-shot/backup path can throw
    // an AbortError instead. If this turn was aborted, treat it as a stop, not a
    // failure: synthesize an empty outcome and let the success path finalize the
    // (possibly partial-less) turn 'complete'.
    if (abortController?.signal.aborted) {
      outcome = {
        loop: emptyLoopResult(),
        reply: '',
        emptyReplySubstituted: false,
        persistedThoughts: [],
        toolStats: null,
        ctx,
      };
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
  // The core already applied the empty-reply fallback (a user Stop keeps its
  // partial reply — see runResponderLoop) and computed the thought trail +
  // tool-outcome ledger. Defensive strip — the web /assistant is text-only
  // today, so any audio tags Saskia emits (because she carried the habit over
  // from her Telegram persona) would render as literal brackets in the chat
  // bubble. If we ever add web TTS playback, this is the branch point where
  // voice-mode reply would skip the strip.
  const reply = stripAudioTags(outcome.reply).text;

  // Finalize the pending outbound row: fill the composed reply + flip the status
  // to 'complete'. Journaled, so a crash-resume re-applies it idempotently.
  const { persistedThoughts, toolStats } = outcome;
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
  const outbound: AssistantMessage = finalized ?? {
    ...outboundPending,
    text: reply,
    model: agent.model,
    status: 'complete',
  };

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
      tokensOut: outcome.loop.tokensOut,
    });
  }

  return { inbound, outbound, reply, artifacts: outcome.loop.artifacts };
}
