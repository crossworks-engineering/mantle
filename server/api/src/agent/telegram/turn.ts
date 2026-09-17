/**
 * One Telegram turn, from transcription to a persisted outbound row.
 *
 * This was the 252-line callback passed to `startTrace` inside
 * handleTelegramMessage — the deepest code in the file, at indent 6, and the
 * only part of the turn with no name of its own. handleTelegramMessage keeps
 * what it is actually about: load the row, decide the message is actionable,
 * claim it exactly once, resolve the responder, and open the trace.
 *
 * Body moved verbatim (dedented by one level). Every step name, trace kind,
 * meta field and log line is unchanged, which is what the 15 tests in
 * telegram-turn.test.ts assert.
 */

import { eq } from 'drizzle-orm';
import { db, agents, type Agent } from '@mantle/db';
import { accountById } from '@mantle/telegram';
import { loadProfilePreferences, noteInboundChannel } from '@mantle/content';
import { getChatAdapter } from '@mantle/voice';
import { getAgentTtsWorker } from '@mantle/db';
import { runDurableStep, step } from '@mantle/tracing';
import {
  buildChatMessages,
  loadConversationContext,
  recordTurn,
  type ConversationContext,
  type UserImage,
} from '@mantle/runtime/agent';
import {
  assembleResponderTurn,
  runResponderLoop,
  runWithImageFallback,
} from '@mantle/runtime/assistant';
import { log } from '@mantle/tracing';
import { audioTagInstructionsFor, transcribeInboundVoice } from './voice';
import { buildResponderInput } from './responder-input';
import { deliverReply } from './deliver';
import { persistOutbound } from './persist';
import { parseVoiceMarker, sendApology, toConversationAttachments } from './helpers';
import type { AttachmentContext, InboundRow } from './types';

/** Same scope string as runtime.ts, so every line this turn emits reads
 *  `[agent] ...` exactly as it did before the move. */
const logger = log('agent');

export async function runTelegramTurn(args: {
  row: InboundRow;
  agent: Agent;
  apiKey: string;
  ownerId: string;
  wasVoice: boolean;
  voiceFileId: string | null;
  attachmentContext: AttachmentContext | null;
}): Promise<void> {
  const { row, agent, apiKey, ownerId, wasVoice, voiceFileId, attachmentContext } = args;
  // ── 0. Transcribe voice (if any) BEFORE anything downstream reads
  // `row.text`. Failure downgrades the turn to a text apology rather
  // than crashing the trace. See telegram/voice.ts.
  if (voiceFileId) {
    const ok = await transcribeInboundVoice({ ownerId, row, voiceFileId });
    if (!ok) {
      await sendApology(
        row,
        "Sorry love — I couldn't pick up that voice clip. Could you try again, or type it out?",
      );
      return;
    }
  }

  // Record the inbound turn into the unified per-(owner, agent)
  // conversation stream (assistant_messages, channel='telegram') — the
  // single source of truth the responder reads history from and the
  // summarizer rolls up. telegram_messages stays the transport/brain
  // record. Done HERE (not at poll time) because the responder agent is
  // only resolved now; the atomic processed-claim above guarantees this
  // runs exactly once per inbound. See docs/conversation.md.
  // Journaled (like the web /assistant path) so a crash-resume doesn't
  // insert a duplicate inbound conversation row.
  const convInbound = await runDurableStep('record_inbound', () =>
    recordTurn({
      ownerId,
      agentId: agent.id,
      direction: 'inbound',
      text: row.text,
      channel: 'telegram',
      attachments: toConversationAttachments(row.attachments, attachmentContext?.nodeId ?? null),
      externalRef: {
        accountId: row.accountId,
        chatId: row.telegramChatId,
        ...(row.telegramMessageId ? { messageId: row.telegramMessageId } : {}),
      },
    }),
  );
  // Telegram is reminder-capable, so messaging a bot makes Telegram the
  // reminder destination (until the user next messages from the app).
  // Best-effort — must never break the inbound. See reminder-delivery-routing.md.
  void noteInboundChannel(ownerId, 'telegram');

  // Shared responder-turn assembly (audit #5c): identity + skills
  // prompt (+ the audio-tag suffix), volatile context (time line +
  // open-heartbeat awareness), tool allowlist + heartbeat affordance,
  // thinking budget, per-agent loop overrides. Same strings, same
  // gating as the web /assistant path — one implementation, no drift.
  const audioTagInstructions = await audioTagInstructionsFor(ownerId, agent);
  const prefs = await loadProfilePreferences(ownerId);
  const assembled = await assembleResponderTurn({
    ownerId,
    agent,
    prefs,
    logPrefix: '[agent]',
    systemPromptSuffix: audioTagInstructions,
    heartbeatSurface: { kind: 'telegram', chatId: row.telegramChatId },
  });
  // Replay the open-heartbeats check as a step so /traces keeps its
  // "influenced by heartbeat X" pivot (meta.related_slugs) — the query
  // itself now runs inside the shared assembly. (Audit P-trace-5.)
  await step(
    {
      name: 'open_heartbeats_check',
      kind: 'db_read',
      input: { surface: 'telegram', chat_id: row.telegramChatId },
    },
    async (h) => {
      h.setMeta({
        count: assembled.relatedHeartbeatSlugs.length,
        related_slugs: assembled.relatedHeartbeatSlugs,
      });
    },
  );

  // What the responder is asked (transcript-default; raw pixels only
  // when the model can see and there is no transcript). See
  // telegram/responder-input.ts.
  const input = buildResponderInput({
    rowText: row.text,
    model: agent.model,
    attachmentContext,
  });

  // Resolve the chat adapter for this agent's provider. The
  // agents table grew a `provider` column in migration 0048
  // (defaulted to 'openrouter' for existing rows, equivalent to
  // the pre-3c hard-wired routing).
  const chatAdapter = getChatAdapter(agent.provider);
  if (!chatAdapter) {
    throw new Error(
      `responder: no chat adapter registered for provider '${agent.provider}' (agent ${agent.slug})`,
    );
  }

  // Retrieval context loads ONCE (memoized) inside the shared core's
  // load_context step; the image-retry path reuses the same context
  // rather than re-paying retrieval.
  let ctxPromise: Promise<ConversationContext> | null = null;
  const loadContext = () =>
    (ctxPromise ??= loadConversationContext({
      ownerId,
      agent,
      inboundText: row.text,
      // Exclude the inbound we just recorded; only look before it.
      excludeMessageId: convInbound.id,
      // `new Date(...)` because on a crash-resume replay the journaled
      // record_inbound row deserializes createdAt to an ISO string.
      before: new Date(convInbound.createdAt),
    }).then((ctx) => {
      logger.info(
        `→ ${row.fromName ?? 'unknown'} via ${chatAdapter.adapterName}:${agent.model} (${row.text.length}c, ${ctx.history.length} turns, ${ctx.digests.length} digests, ${ctx.facts.length} facts, ${ctx.contentHits.length} content)`,
      );
      return ctx;
    }));

  // The shared loop core (audit #5c stage 2): load_context step + tool
  // loop + post-loop bookkeeping (empty-reply fallback b3, thought
  // trail b4, tool-outcome ledger b5) — one implementation with the web
  // /assistant and Team Chat paths. Runs inside this turn's single
  // responder_turn trace; delivery + persistence below stay Telegram's.
  const runCore = (image: UserImage | undefined, userText: string) =>
    runResponderLoop({
      ownerId,
      agent,
      adapter: chatAdapter,
      apiKey,
      prefs,
      logPrefix: '[agent]',
      assembled,
      loadContext,
      buildMessages: (ctx) =>
        step({ name: 'build_messages', kind: 'compute' }, async (h) => {
          const m = buildChatMessages({
            model: agent.model,
            provider: agent.provider,
            systemPrompt: assembled.effectiveSystemPrompt,
            volatileContext: assembled.volatileContext,
            personaNotes: ctx.personaNotes,
            facts: ctx.facts,
            digests: ctx.digests,
            corpusMap: ctx.corpusMap,
            contentHits: ctx.contentHits,
            chunkHits: ctx.chunkHits,
            relations: ctx.relations,
            history: ctx.history,
            newUserText: userText,
            userImage: image,
          });
          h.setMeta({
            blockCount: m.length,
            skillCount: assembled.attachedSkills.length,
            hasImage: !!image,
          });
          return m;
        }),
      // Surface lets worker-delegation tools (synthesize_speech,
      // etc.) target the right Telegram chat. The replyTo is the
      // message that triggered this turn so the bot's outbound
      // threads under it.
      surface: {
        kind: 'telegram',
        telegramChatId: row.telegramChatId,
        ...(row.telegramMessageId ? { replyToTelegramMessageId: row.telegramMessageId } : {}),
      },
    });

  // Run via the shared image-fallback wrapper: if the responder errors
  // with the raw image attached, retry once text-only, grounded in the
  // transcript marker (parity drift b2, audit #5c — the web path grew
  // this after Bedrock's opaque "Could not process image" failures).
  // Both attempts run inside this turn's single responder_turn trace
  // (the web path traces per-attempt); the retry shows up as a second
  // load_context (memoized) + build_messages step pair.
  const outcome = await runWithImageFallback({
    canSeeImage: input.canSeeImage,
    logPrefix: '[agent]',
    withImage: () => runCore(input.userImage, input.imagePrimaryText),
    textOnly: () => runCore(undefined, input.responderUserText),
  });
  const loopOutcome = outcome.loop;
  // The core substitutes the shared fallback when the model returns
  // empty twice (b3 — the old Telegram copy went silent instead), so
  // this guard is now defensive only.
  if (!outcome.reply) {
    logger.error('empty reply from model — not sending');
    return;
  }
  const { reply, requestedVoice } = parseVoiceMarker(outcome.reply);
  if (!reply) {
    // She emitted ONLY the marker — treat as empty reply.
    logger.error('reply was only the [VOICE] marker; not sending');
    return;
  }
  if (loopOutcome.toolCalls.length > 0) {
    logger.info(
      `tool loop: ${loopOutcome.iterations} round(s), ` +
        `tool calls: ${loopOutcome.toolCalls.map((c) => c.slug).join(', ')}`,
    );
  }

  const account = await accountById(row.accountId);
  if (!account) {
    logger.error('no enabled telegram account for chat', row.telegramChatId);
    return;
  }

  // Voice in → voice out. Drives off the default `kind='tts'`
  // ai_workers row. If none exists or its key is missing, we
  // fall through to text rather than crash the reply.
  // `wasVoice` (user voice-messaged) OR `requestedVoice` (LLM
  // emitted `[VOICE]` marker) opt in. Enable/disable happens by
  // enabling/disabling the TTS worker row. Per-agent voice: the TTS
  // worker this agent pins (agent.ttsWorkerId), else the owner's default.
  const replyAsVoice = wasVoice || requestedVoice;
  const ttsWorker = replyAsVoice ? await getAgentTtsWorker(ownerId, agent.ttsWorkerId) : null;

  const delivery = await deliverReply({
    ownerId,
    account,
    row,
    reply,
    replyAsVoice,
    ttsWorker,
  });
  await persistOutbound({ ownerId, row, account, agent, reply, delivery, outcome });

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

  if (delivery.delivered) {
    logger.info(`✓ replied (${reply.length}c)`);
  } else {
    logger.warn(`reply saved but Telegram send failed: ${delivery.sendError}`);
    // The reply is already persisted above (undelivered); fail the trace
    // here so the delivery failure surfaces without losing the reply.
    throw new Error(`reply generated + saved but Telegram send failed: ${delivery.sendError}`);
  }
}
