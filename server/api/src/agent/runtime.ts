/**
 * Mantle agent runtime — absorbed into server/api (was the standalone server/api
 * service). Listens on Postgres for `telegram_message_inserted` notifies and
 * replies via OpenRouter, plus the summarize/extract/heartbeat listeners and the
 * reflector/heartbeat/extract-sweep ticks. `startAgentRuntime()` wires it all up
 * in the runner process; the process is kept alive by DBOS.
 *
 *   pg_notify (from migration 0009 trigger; only inbound rows now)
 *      ↓
 *   enqueueTelegramTurn(messageId)  → durable DBOS workflow (telegram-turn.ts)
 *      ↓
 *   handleTelegramMessage(messageId)  — runs under withDurableSteps
 *      ↓
 *   resolve responder agent from `agents` (highest-priority enabled row)
 *      ↓
 *   load conversation history (last N turns, inbound + outbound, chronological)
 *      ↓
 *   buildChatMessages — system prompt with cache_control for anthropic/* models
 *      ↓
 *   OpenRouter call → send reply → persist outbound row + node → mark inbound processed
 *
 * Agent config (model, persona, API key, memory depth) lives in the DB now —
 * `AGENT_MODEL` / `AGENT_PERSONA` env vars are dead. Configure via
 * `/settings/agents` in the web app.
 */

import postgres from 'postgres';
import { and, asc, eq, gte, inArray, isNull, ne, sql } from 'drizzle-orm';
import {
  db,
  agents,
  toolGroups,
  channels,
  nodes,
  telegramMessages,
  telegramChats,
  telegramAccounts,
  waitForOwner,
  type Agent,
} from '@mantle/db';
import { accountById } from '@mantle/telegram';
import { loadProfilePreferences, noteInboundChannel } from '@mantle/content';

import { sweepLegacyTables } from '@mantle/content/table-storage';

import { getChatAdapter } from '@mantle/voice';
import { getAgentTtsWorker } from '@mantle/db';
import { resolveEmbeddingConfig } from '@mantle/embeddings';
import { runDurableStep, startTrace, step } from '@mantle/tracing';
import {
  buildChatMessages,
  invokeAgent,
  loadConversationContext,
  recordTurn,
  resolveChatKey,
  type ConversationContext,
  type UserImage,
} from '@mantle/agent-runtime';
import {
  assembleResponderTurn,
  runResponderLoop,
  runWithImageFallback,
} from '@mantle/assistant-runtime';
import { registerAgentInvoker, seedBuiltinTools } from '@mantle/tools';
import { HEARTBEAT_DUE_CHANNEL, registerHeartbeatTools, tickHeartbeats } from '@mantle/heartbeats';

// Register the cross-package bridge so the `invoke_agent` builtin (in
// @mantle/tools) can synchronously delegate to another agent through
// the runtime here. Idempotent; safe to call once at boot.
registerAgentInvoker(invokeAgent);

// Register the 5 heartbeat-control builtins (heartbeat_complete,
// heartbeat_snooze, heartbeat_update_state, heartbeat_list,
// heartbeat_fire). These live in @mantle/heartbeats rather than
// @mantle/tools to avoid an import cycle (heartbeats already depends
// on tools). Must run BEFORE seedBuiltinTools() — the seed reads
// from the in-memory registry. Idempotent.
registerHeartbeatTools();
import { summarizeAgentConversation } from './summarizer.js';
import { enqueueExtract, startExtractQueue, stopExtractQueue } from './extract-queue.js';
import { reflect } from './reflector.js';
import { CONVERSATIONAL_ROLES, pickFallbackResponder } from './agent-select.js';
import { computeFloorGroupAdditions } from './core-tools.js';
import { ingestTelegramAttachment } from './telegram/ingest-attachment';
import { audioTagInstructionsFor, transcribeInboundVoice } from './telegram/voice';
import { buildResponderInput } from './telegram/responder-input';
import { deliverReply } from './telegram/deliver';
import { persistOutbound } from './telegram/persist';
import {
  parseVoiceMarker,
  sendApology,
  startTyping,
  toConversationAttachments,
} from './telegram/helpers';
import type { AttachmentContext, FileAttachment, InboundRow } from './telegram/types';
import { env } from '@mantle/config';
import { errorMessage } from '@mantle/std';

// The owner id is resolved ONCE in startAgentRuntime (waitForOwner: either
// ALLOWED_USER_ID or the sole auth.users row) and handed to every stage
// explicitly. `runtimeOwner` is the one slot the durable Telegram workflow
// reads, because DBOS invokes handleTelegramMessage(messageId) without a way
// to thread the owner through the workflow input. Seeded from the env so a
// direct call (the test harness, a one-off script) works without a boot;
// startAgentRuntime overwrites it with the resolved owner.
let runtimeOwner: string | undefined = env('ALLOWED_USER_ID');
const DATABASE_URL = env('DATABASE_URL');

if (!DATABASE_URL) {
  console.error('[agent] DATABASE_URL must be set');
  process.exit(1);
}

/** Per-chat in-flight tracker. Prevents two replies racing for the same chat. */
const inflight = new Map<string, Promise<void>>();

/** Fetch the active agent for an inbound chat message.
 *
 *  Resolution order (channel-based, role-decoupled — docs/comms-channels.md §6):
 *    1. Per-chat override (`telegram_chats.responder_agent_id`) — most specific.
 *    2. The inbound **channel's** `agent_id` — the agent this transport is
 *       attached to. The normal path: an enabled channel always carries an agent.
 *    3. Last resort (`pickFallbackResponder`, unit-tested): highest-priority
 *       enabled conversational agent — covers a channel-less/legacy account so
 *       an inbound is never silently dropped, and never a background worker. No
 *       `role='responder'` privileging (that gate is gone).
 */
async function resolveResponderAgent(
  ownerId: string,
  overrideAgentId: string | null,
  channelAgentId?: string | null,
): Promise<Agent | null> {
  for (const pinnedId of [overrideAgentId, channelAgentId]) {
    if (!pinnedId) continue;
    const [pinned] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, pinnedId), eq(agents.ownerId, ownerId), eq(agents.enabled, true)))
      .limit(1);
    if (pinned) return pinned;
    // Pinned/bound agent disabled or missing → fall through to the next candidate.
  }
  const candidates = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.ownerId, ownerId),
        eq(agents.enabled, true),
        inArray(agents.role, [...CONVERSATIONAL_ROLES]),
      ),
    );
  return pickFallbackResponder(candidates);
}

/**
 * Run one Telegram responder turn for an inbound message. Exported so the
 * durable runner (server/api/src/workflows/telegram-turn.ts) can execute it as a
 * DBOS workflow under `withDurableSteps`: every @mantle/tracing `step()` here
 * (download/extract, transcribe, the tool loop, send_telegram, persist_outbound)
 * plus the two `runDurableStep` boundaries below (the atomic claim + the inbound
 * recordTurn) becomes a journaled step, so a crash mid-turn resumes from the
 * last completed step — no re-sent Telegram message, no duplicate rows. Outside
 * a workflow (e.g. a direct call), step()/runDurableStep are pure passthrough.
 */
export async function handleTelegramMessage(messageId: string): Promise<void> {
  const [selected] = await db
    .select({
      id: telegramMessages.id,
      processed: telegramMessages.processed,
      direction: telegramMessages.direction,
      chatPk: telegramMessages.chatId,
      text: telegramMessages.text,
      sentAt: telegramMessages.sentAt,
      telegramChatId: telegramChats.telegramChatId,
      telegramMessageId: telegramMessages.telegramMessageId,
      fromName: telegramMessages.fromName,
      accountId: telegramMessages.accountId,
      responderAgentId: telegramChats.responderAgentId,
      channelAgentId: channels.agentId,
      attachments: telegramMessages.attachments,
    })
    .from(telegramMessages)
    .innerJoin(telegramChats, eq(telegramMessages.chatId, telegramChats.id))
    .innerJoin(telegramAccounts, eq(telegramMessages.accountId, telegramAccounts.id))
    // Left join — a legacy account may not have a channel yet during the
    // dual-read transition; resolveResponderAgent falls back accordingly.
    .leftJoin(channels, eq(telegramAccounts.channelId, channels.id))
    .where(eq(telegramMessages.id, messageId))
    .limit(1);

  if (!selected) return;
  const row: InboundRow = selected;
  if (row.processed) return;
  // Defensive — the trigger only fires for inbound but a manual INSERT could
  // get past it. We never reply to our own outbound row.
  if (row.direction !== 'inbound') return;

  // Find a voice attachment if any. Telegram syncs voice notes with a
  // placeholder `text='(voice message)'` and the file_id on attachments.
  // We transcribe before the early-return below so the rest of the
  // pipeline sees real text. `wasVoice` flips the reply path to
  // sendVoice as well — voice-in → voice-out, configurable per agent.
  const voiceAttachment = (row.attachments ?? []).find(
    (a): a is FileAttachment => a.kind === 'voice' && typeof a.file_id === 'string',
  );
  const wasVoice = !!voiceAttachment;
  const voiceFileId: string | null = voiceAttachment?.file_id ?? null;

  // Attachment branch — a photo OR a document. Save the bytes to /files, then
  // FALL THROUGH to the responder so it can answer about it (parity with the
  // web /assistant). See telegram/ingest-attachment.ts.
  const fileAttachment = (row.attachments ?? []).find(
    (a): a is FileAttachment =>
      (a.kind === 'photo' || a.kind === 'document') && typeof a.file_id === 'string',
  );

  // Nothing actionable: no text, no voice, no attachment (sticker/etc.). Mark
  // processed and bail before any trace/claim overhead.
  const textIsEmpty = !row.text || !row.text.trim() || row.text === '(voice message)';
  if (textIsEmpty && !wasVoice && !fileAttachment) {
    await db
      .update(telegramMessages)
      .set({ processed: true, processedAt: new Date() })
      .where(eq(telegramMessages.id, row.id));
    return;
  }

  // Single atomic claim up front — covers text, voice, AND attachment paths.
  // Flip processed=true BEFORE any work; if the row was already claimed (a
  // prior invocation that crashed mid-reply, or a racing notify in another
  // process), the UPDATE returns 0 rows and we exit silently. Tradeoff: a
  // crash between this UPDATE and the Telegram send means the user gets no
  // reply — but no duplicate either, the friendlier failure on a chat
  // surface. Hot-reload-driven duplicates were the original symptom. Doing
  // it here (before the download) also stops a duplicate notify from
  // double-ingesting the attachment.
  // Journaled so a crash-resume doesn't re-run the claim and short-circuit:
  // on replay this returns the original `true` (the row is now processed, so a
  // bare re-run would see 0 rows and wrongly abandon the turn mid-flight).
  const claimed = await runDurableStep('claim_message', async () => {
    const claim = await db
      .update(telegramMessages)
      .set({ processed: true, processedAt: new Date() })
      .where(and(eq(telegramMessages.id, row.id), eq(telegramMessages.processed, false)))
      .returning({ id: telegramMessages.id });
    return claim.length > 0;
  });
  if (!claimed) return;

  // The owner is resolved once at boot (startAgentRuntime); every stage below
  // receives it explicitly rather than reading the module-level slot.
  const ownerId = runtimeOwner;
  if (!ownerId) {
    throw new Error(
      '[agent] handleTelegramMessage ran before startAgentRuntime resolved the owner',
    );
  }

  // Ingest the attachment (if any) into a file node + inline extraction BEFORE
  // the responder runs. The save fires the extractor (durable metadata); this
  // inline pass is for the live reply only.
  let attachmentContext: AttachmentContext | null = null;
  if (fileAttachment) {
    attachmentContext = await ingestTelegramAttachment({ ownerId, row, fileAttachment });
    // Couldn't fetch / ingest the attachment (no account, or a transient
    // download failure). The row is already claimed so we won't retry — at
    // least tell the user instead of going silent.
    if (!attachmentContext) {
      await sendApology(row, "Sorry — I couldn't fetch that file. Could you send it again?");
      return;
    }
  }

  // Resolve the responder + key BEFORE opening a trace. Failure modes here
  // (no agent, no key) don't generate traces — there's nothing useful to
  // record about "the system was misconfigured."
  const agent = await resolveResponderAgent(ownerId, row.responderAgentId, row.channelAgentId);
  if (!agent) {
    console.error(
      `[agent] no enabled responder agent — skipping ${messageId}. Create one at /settings/agents.`,
    );
    return;
  }
  // Resolve the responder's chat key via the shared resolver (keyless `local`
  // → 'local' sentinel; cloud → pinned/service key, else skip). Same single
  // source of truth the worker pre-flights + the dispatch path use.
  const keyCheck = await resolveChatKey(ownerId, agent);
  if (!keyCheck.ok) {
    console.error(
      `[agent] responder agent '${agent.slug}' ${keyCheck.detail} — skipping. Edit it at /settings/agents.`,
    );
    return;
  }
  const apiKey = keyCheck.apiKey;

  const lockKey = row.telegramChatId;
  const prev = inflight.get(lockKey);
  let release: () => void = () => {};
  const lockPromise = new Promise<void>((res) => {
    release = res;
  });
  if (prev) await prev;
  inflight.set(lockKey, lockPromise);

  // Show the native "typing…" indicator for the whole think+generate
  // window. Telegram auto-clears it when the reply lands; the keep-alive
  // re-pokes every 4s until we stop it in the finally below.
  let stopTyping: () => void = () => {};

  try {
    const typingAccount = await accountById(row.accountId).catch(() => null);
    if (typingAccount) stopTyping = startTyping(typingAccount, row.telegramChatId);
    await startTrace(
      {
        kind: 'responder_turn',
        ownerId,
        subjectId: row.id,
        subjectKind: 'telegram_message',
        agentId: agent.id,
        data: {
          telegramChatId: row.telegramChatId,
          model: agent.model,
          wasVoice,
          wasAttachment: !!attachmentContext,
          attachmentKind: attachmentContext?.kind ?? null,
        },
      },
      async () => {
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
            attachments: toConversationAttachments(
              row.attachments,
              attachmentContext?.nodeId ?? null,
            ),
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
            console.log(
              `[agent] → ${row.fromName ?? 'unknown'} via ${chatAdapter.adapterName}:${agent.model} (${row.text.length}c, ${ctx.history.length} turns, ${ctx.digests.length} digests, ${ctx.facts.length} facts, ${ctx.contentHits.length} content)`,
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
          console.error('[agent] empty reply from model — not sending');
          return;
        }
        const { reply, requestedVoice } = parseVoiceMarker(outcome.reply);
        if (!reply) {
          // She emitted ONLY the marker — treat as empty reply.
          console.error('[agent] reply was only the [VOICE] marker; not sending');
          return;
        }
        if (loopOutcome.toolCalls.length > 0) {
          console.log(
            `[agent] tool loop: ${loopOutcome.iterations} round(s), ` +
              `tool calls: ${loopOutcome.toolCalls.map((c) => c.slug).join(', ')}`,
          );
        }

        const account = await accountById(row.accountId);
        if (!account) {
          console.error('[agent] no enabled telegram account for chat', row.telegramChatId);
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
          console.log(`[agent] ✓ replied (${reply.length}c)`);
        } else {
          console.warn(`[agent] reply saved but Telegram send failed: ${delivery.sendError}`);
          // The reply is already persisted above (undelivered); fail the trace
          // here so the delivery failure surfaces without losing the reply.
          throw new Error(
            `reply generated + saved but Telegram send failed: ${delivery.sendError}`,
          );
        }
      },
    );
  } catch (err) {
    console.error('[agent] handle failed:', errorMessage(err));
  } finally {
    stopTyping();
    release();
    if (inflight.get(lockKey) === lockPromise) {
      inflight.delete(lockKey);
    }
  }
}

async function drainPending(
  enqueueTelegramTurn: (messageId: string) => Promise<unknown>,
): Promise<void> {
  // Self-heal: inbound rows that already have an outbound reply but were
  // never marked processed (typically because a previous run crashed or
  // was hot-reloaded between sending Telegram and the final DB UPDATE).
  // Flip them to processed instead of generating a duplicate reply.
  const healed = await db.execute(sql`
    update telegram_messages m
       set processed = true,
           processed_at = coalesce(processed_at, now())
     where m.processed = false
       and m.direction = 'inbound'
       and exists (
         select 1 from telegram_messages r
          where r.reply_to_id = m.id
            and r.direction = 'outbound'
       )
     returning m.id
  `);
  const healedCount = Array.isArray(healed)
    ? healed.length
    : ((healed as { count?: number }).count ?? 0);
  if (healedCount > 0) {
    console.log(`[agent] drain: healed ${healedCount} previously-replied message(s)`);
  }

  // Now the genuinely-pending set: unprocessed, inbound, no reply yet.
  const rows = await db
    .select({ id: telegramMessages.id })
    .from(telegramMessages)
    .where(and(eq(telegramMessages.processed, false), eq(telegramMessages.direction, 'inbound')))
    .orderBy(asc(telegramMessages.sentAt));
  if (rows.length === 0) {
    console.log('[agent] drain: queue empty');
    return;
  }
  console.log(`[agent] drain: ${rows.length} pending message(s)`);
  // Enqueue durable workflows (idempotent on message id) rather than running
  // inline; the queue's concurrency cap throttles the backlog.
  for (const r of rows) {
    await enqueueTelegramTurn(r.id);
  }
}

/**
 * Boot-time recovery for the extractor queue. The extract jobs themselves are
 * durable (pg-boss), so a crash no longer loses queued work — but a node
 * inserted while the agent (and its boss) was DOWN fired `pg_notify` into the
 * void with no listener, so no job was ever enqueued. This catches that case by
 * scanning for recently-inserted nodes of an extractable type that still have
 * no embedding, and enqueueing them through the same `enqueueExtract` path as a
 * fresh `pg_notify('node_ingested')`.
 *
 * Window + cap are configurable (MANTLE_EXTRACT_DRAIN_WINDOW_HOURS, default 7d;
 * MANTLE_EXTRACT_DRAIN_LIMIT, default 1000) so a longer outage can still
 * self-heal without re-extracting years of history on an old DB. The cap is
 * NOT optional: each drained node is an extraction (LLM calls), so an unbounded
 * sweep over a large backlog would be a cost burst. A truncated drain is logged
 * loudly so a partial self-heal is visible, not silent — re-run or raise the
 * cap to catch up. The extractor's own per-agent / per-type guards take it from
 * there.
 */
async function drainUnextractedNodes(ownerId: string): Promise<void> {
  const windowHours = Number(env('MANTLE_EXTRACT_DRAIN_WINDOW_HOURS')) || 168;
  const limit = Number(env('MANTLE_EXTRACT_DRAIN_LIMIT')) || 1000;
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);
  const conds = and(
    eq(nodes.ownerId, ownerId),
    ne(nodes.type, 'branch'),
    gte(nodes.createdAt, since),
    isNull(nodes.embedding),
  );
  const countRows = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(nodes)
    .where(conds);
  const total = countRows[0]?.total ?? 0;
  if (!total) {
    console.log('[agent] drain extractor: queue empty');
    return;
  }
  const rows = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(conds)
    .orderBy(asc(nodes.createdAt))
    .limit(limit);
  if (total > rows.length) {
    console.warn(
      `[agent] drain extractor: ${total} unextracted node(s) in last ${windowHours}h; queueing the oldest ${rows.length} (capped by MANTLE_EXTRACT_DRAIN_LIMIT=${limit} to avoid an extraction cost burst — re-run or raise the cap to catch up).`,
    );
  } else {
    console.log(
      `[agent] drain extractor: queueing ${rows.length} unextracted node(s) from last ${windowHours}h`,
    );
  }
  for (const r of rows) await enqueueExtract(r.id);
}

/**
 * Periodic safety net for the fire-and-forget gap. `pg_notify('node_ingested')`
 * is delivered only if the agent's LISTEN is alive at that instant — a dropped
 * listener (Postgres blip) or a wedged extraction silently loses the event, and
 * the node is then never extracted with no retry until a *restart's* boot-drain.
 * This closes that gap on a timer, with no restart needed.
 *
 * Predicate is a strict SUBSET of the boot-drain (`embedding IS NULL`) PLUS
 * "has NO extractor_run at all" — i.e. genuinely never processed (the missed-
 * event signature). That extra clause makes it **loop-safe**: a node that was
 * processed-and-skipped (an SVG, a telegram message, a conversation digest) HAS
 * a terminal run, so it's excluded; the boot-drain's bare `embedding IS NULL`
 * would re-churn those every sweep. Once a swept node is processed it gains a
 * run and drops out for good. Capped so a large miss catches up over a few
 * sweeps rather than a burst. Quiet unless it actually re-queues something.
 */
async function sweepMissedExtractions(ownerId: string): Promise<void> {
  const windowHours = Number(env('MANTLE_EXTRACT_DRAIN_WINDOW_HOURS')) || 168;
  const limit = Number(env('MANTLE_EXTRACT_SWEEP_LIMIT')) || 200;
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);
  const rows = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        ne(nodes.type, 'branch'),
        gte(nodes.createdAt, since),
        isNull(nodes.embedding),
        sql`NOT EXISTS (SELECT 1 FROM public.traces t WHERE t.subject_id = ${nodes.id} AND t.kind = 'extractor_run')`,
      ),
    )
    .orderBy(asc(nodes.createdAt))
    .limit(limit);
  if (rows.length === 0) return;
  console.log(
    `[agent] extract sweep: re-queueing ${rows.length} node(s) with no extractor_run (missed node_ingested)`,
  );
  for (const r of rows) await enqueueExtract(r.id);
}

/**
 * Boot-time log of the active embedder. Since migration 0061 there is exactly
 * ONE embedder (the `embedding_config` row) — no per-agent or per-worker
 * override exists any more, so the write-side and query-side models can't
 * diverge by construction. We just surface what's configured. The remaining
 * sharp edge — a backup route serving a different dimension than the column —
 * is caught live by `/settings/embedding`'s per-route dim probe, not re-probed
 * here at boot (that would add a network call to every start).
 */
async function assertEmbeddingModelConsistency(ownerId: string): Promise<void> {
  try {
    const config = await resolveEmbeddingConfig(ownerId);
    const backup = config.backup
      ? ` · backup via ${config.backup.provider}${config.backup.label ? ` (${config.backup.label})` : ''}`
      : ' · no backup';
    console.log(
      `[agent] embedder: ${config.model} @ ${config.dimensions}d via ${config.primary.provider}${backup}`,
    );
  } catch (err) {
    console.error(
      '[agent] embedding config check failed:',
      err instanceof Error ? err.message : err,
    );
  }
}

/** Debounce window for summarize_due — collapses a burst of inserts for the
 *  same agent (a user turn + the reply within the same second) into one
 *  summarization check. Since migration 0072, summarize_due fires with an
 *  AGENT id (AFTER INSERT on assistant_messages, ALL channels), so one
 *  debounced pass covers web + Telegram + any future channel for that agent.
 *  The check itself is cheap (one indexed COUNT). */
const SUMMARIZE_DEBOUNCE_MS = 2000;
const summarizePending = new Set<string>(); // agent ids
let summarizeTimer: NodeJS.Timeout | null = null;

// Per-agent in-flight guard. The debounce only collapses a 2s burst, but a
// summarize run holds a 10-60s LLM call — a notify landing mid-run used to
// start a SECOND run over the same undigested batch (duplicate digests,
// orphaned nodes). One run per agent at a time; a notify during a run sets
// the rerun flag so the fresh state is checked once the run finishes (the
// threshold count makes that re-check cheap). The summarizer's own
// transactional batch claim is the DB-level backstop for anything this
// in-process guard can't see.
const summarizeInflight = new Set<string>();
const summarizeRerun = new Set<string>();

function runSummarize(ownerId: string, agentId: string): void {
  if (summarizeInflight.has(agentId)) {
    summarizeRerun.add(agentId);
    return;
  }
  summarizeInflight.add(agentId);
  summarizeAgentConversation(ownerId, agentId)
    .catch((err) =>
      console.error('[agent] summarize error:', err instanceof Error ? err.message : err),
    )
    .finally(() => {
      summarizeInflight.delete(agentId);
      if (summarizeRerun.delete(agentId)) runSummarize(ownerId, agentId);
    });
}

function scheduleSummarize(ownerId: string, agentId: string): void {
  summarizePending.add(agentId);
  if (summarizeTimer) return;
  summarizeTimer = setTimeout(() => {
    summarizeTimer = null;
    const batch = [...summarizePending];
    summarizePending.clear();
    for (const id of batch) runSummarize(ownerId, id);
  }, SUMMARIZE_DEBOUNCE_MS);
}

/**
 * Ensure every enabled conversational agent (responder + assistant) holds the
 * core capability floor, granted as tool GROUPS. Returns the slugs of agents
 * that were updated. Idempotent.
 *
 * P6 — groups are the sole grant: the floor is a set of GROUP slugs, and we add
 * any floor group the agent neither already holds nor has fully covered by its
 * other granted groups. Direct `tool_slugs` are deliberately NOT counted as
 * coverage (they're being removed in P6b) — so an operator persona that still
 * holds floor tools flat is migrated onto the equivalent groups here.
 */
async function ensureCoreToolsOnConversationalAgents(ownerId: string): Promise<string[]> {
  const groupRows = await db
    .select({ slug: toolGroups.slug, toolSlugs: toolGroups.toolSlugs })
    .from(toolGroups)
    .where(and(eq(toolGroups.ownerId, ownerId), eq(toolGroups.enabled, true)));
  const groupTools = new Map(groupRows.map((g) => [g.slug, g.toolSlugs ?? []]));
  const rows = await db
    .select({ id: agents.id, slug: agents.slug, toolGroupSlugs: agents.toolGroupSlugs })
    .from(agents)
    .where(
      and(
        eq(agents.ownerId, ownerId),
        eq(agents.enabled, true),
        inArray(agents.role, ['responder', 'assistant']),
      ),
    );
  const updated: string[] = [];
  for (const row of rows) {
    const have = new Set<string>(row.toolGroupSlugs ?? []);
    // Add any floor group the agent neither already holds nor has fully covered
    // by its other granted groups (pure logic in core-tools.ts so it's tested).
    const toAdd = computeFloorGroupAdditions(have, groupTools);
    if (toAdd.length === 0) continue;
    await db
      .update(agents)
      .set({ toolGroupSlugs: [...(row.toolGroupSlugs ?? []), ...toAdd], updatedAt: new Date() })
      .where(eq(agents.id, row.id));
    updated.push(row.slug);
  }
  return updated;
}

/** Options for the absorbed agent runtime. `enqueueTelegramTurn` is injected by
 *  server/api (it owns the DBOS workflow registration) to avoid an import cycle
 *  between this module and the workflow that wraps `handleTelegramMessage`. */
export interface AgentRuntimeOptions {
  enqueueTelegramTurn: (messageId: string) => Promise<unknown>;
}

export async function startAgentRuntime(opts: AgentRuntimeOptions) {
  const pg = postgres(DATABASE_URL!, { max: 2 });
  console.log('[agent] starting — config from agents table');

  // Resolve the owner before any owner-scoped work. On a fresh install this
  // blocks until the first account is created in the web app (signup), then
  // proceeds — no ALLOWED_USER_ID env edit, no restart.
  const owner = await waitForOwner({ label: 'agent' });
  runtimeOwner = owner;

  // Seed / refresh built-in tool definitions for this owner. Idempotent —
  // updates name/description/schema on each boot so registry edits in
  // packages/tools/src/builtins.ts propagate without manual DB work.
  try {
    const seedResult = await seedBuiltinTools(owner);
    console.log(`[agent] tools: ${seedResult.inserted} inserted, ${seedResult.updated} updated`);
  } catch (err) {
    console.error('[agent] tool seed failed:', err instanceof Error ? err.message : err);
  }

  // Grant the core capability FLOOR (persona self-edit + task CRUD etc., as
  // tool GROUPS) to the conversational agents so "be more professional" / "add
  // a task" work without manual /settings/tools setup. Idempotent (P6).
  try {
    const granted = await ensureCoreToolsOnConversationalAgents(owner);
    if (granted.length > 0) {
      console.log(`[agent] core tools granted to: ${granted.join(', ')}`);
    }
  } catch (err) {
    console.error('[agent] core tool grant failed:', err instanceof Error ? err.message : err);
  }

  await pg.listen('telegram_message_inserted', (payload: string) => {
    if (!payload) return;
    // Enqueue a durable DBOS workflow (workflowID = message id → idempotent: a
    // duplicate notify dedups to the same run) instead of running the turn
    // inline, so it survives a process restart via DBOS auto-recovery.
    opts
      .enqueueTelegramTurn(payload)
      .catch((err) =>
        console.error(
          '[agent] enqueue telegram turn error:',
          err instanceof Error ? err.message : err,
        ),
      );
  });
  console.log('[agent] LISTENing on telegram_message_inserted');

  // summarize_due now carries an AGENT id (migration 0072: AFTER INSERT on
  // assistant_messages, every channel), so one handler drives summarization
  // for web + Telegram + any future channel. The retired summarize_web_due
  // channel is no longer listened on.
  await pg.listen('summarize_due', (payload: string) => {
    if (!payload) return;
    scheduleSummarize(owner, payload);
  });
  console.log('[agent] LISTENing on summarize_due (per-agent)');

  // Durable, concurrency-capped extractor queue. Must start BEFORE the
  // node_ingested listener (so enqueues land) and before the boot drain below.
  await startExtractQueue(DATABASE_URL!, owner);

  await pg.listen('node_ingested', (payload: string) => {
    if (!payload) return;
    enqueueExtract(payload).catch((err) =>
      console.error('[agent] enqueue extract error:', err instanceof Error ? err.message : err),
    );
  });
  console.log('[agent] LISTENing on node_ingested');

  // NEW-7: low-latency heartbeat wake. createHeartbeat + force-fire
  // paths fire pg_notify('heartbeat_due', ownerId). When we get one,
  // call tickHeartbeats(owner) immediately — same code path as the
  // 60s setInterval, just kicked early so an operator's "Create
  // heartbeat" click reflects in the trace within a couple seconds.
  //
  // Errors swallowed (notify is fire-and-forget at the producer
  // side too): worst case is a missed wake, which the next regular
  // tick recovers from within 60s. Same soft-fail discipline as the
  // reflector tick.
  await pg.listen(HEARTBEAT_DUE_CHANNEL, (payload: string) => {
    if (!payload) return;
    // The payload is the owner id. In single-user mode that's
    // always the owner; we still pass it through for cleanliness.
    tickHeartbeats(payload).catch((err) =>
      console.error(`[agent] heartbeat_due wake error:`, err instanceof Error ? err.message : err),
    );
  });
  console.log(`[agent] LISTENing on ${HEARTBEAT_DUE_CHANNEL}`);

  // Reflector: slow background pass every REFLECTOR_INTERVAL_MS that
  // checks for new outbound activity and appends to persona_notes when
  // something notable surfaces. No-op if no reflector agent is enabled.
  //
  // Backoff: a failing tick (embeddings down, OpenRouter flapping)
  // used to retry every 10 minutes forever. Now we double the wait
  // on each failure up to 1h, and reset on the first success.
  const REFLECTOR_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
  const REFLECTOR_BACKOFF_CAP_MS = 60 * 60 * 1000;
  let reflectBackoffMs = 0;
  let reflectSkipUntil = 0;
  setInterval(() => {
    if (Date.now() < reflectSkipUntil) return;
    reflect(owner)
      .then(() => {
        if (reflectBackoffMs > 0) {
          console.log('[agent] reflector recovered; clearing backoff');
        }
        reflectBackoffMs = 0;
        reflectSkipUntil = 0;
      })
      .catch((err) => {
        reflectBackoffMs = Math.min(
          REFLECTOR_BACKOFF_CAP_MS,
          reflectBackoffMs === 0 ? REFLECTOR_INTERVAL_MS : reflectBackoffMs * 2,
        );
        reflectSkipUntil = Date.now() + reflectBackoffMs;
        console.error(
          `[agent] reflect error (next try in ${Math.round(reflectBackoffMs / 1000)}s):`,
          err instanceof Error ? err.message : err,
        );
      });
  }, REFLECTOR_INTERVAL_MS);
  console.log(
    `[agent] reflector tick every ${REFLECTOR_INTERVAL_MS / 1000}s (with failure backoff up to 1h)`,
  );

  // Heartbeat tick: every minute, look for active heartbeats whose
  // next_fire_at has passed, gate-check each, fire if all gates pass.
  // Mirrors the reflector backoff so a flaky DB / OpenRouter doesn't
  // tight-loop the loop. See packages/heartbeats/src/tick.ts.
  const HEARTBEAT_TICK_MS = 60 * 1000;
  const HEARTBEAT_BACKOFF_CAP_MS = 30 * 60 * 1000;
  let hbBackoffMs = 0;
  let hbSkipUntil = 0;
  setInterval(() => {
    if (Date.now() < hbSkipUntil) return;
    tickHeartbeats(owner)
      .then((report) => {
        if (hbBackoffMs > 0) console.log('[agent] heartbeat tick recovered; clearing backoff');
        hbBackoffMs = 0;
        hbSkipUntil = 0;
        if (report.considered > 0) {
          console.log(
            `[agent] heartbeat tick: considered=${report.considered} fired=${report.fired} skipped=${report.skipped} errored=${report.errored}`,
          );
        }
      })
      .catch((err) => {
        hbBackoffMs = Math.min(
          HEARTBEAT_BACKOFF_CAP_MS,
          hbBackoffMs === 0 ? HEARTBEAT_TICK_MS : hbBackoffMs * 2,
        );
        hbSkipUntil = Date.now() + hbBackoffMs;
        console.error(
          `[agent] heartbeat tick error (next try in ${Math.round(hbBackoffMs / 1000)}s):`,
          err instanceof Error ? err.message : err,
        );
      });
  }, HEARTBEAT_TICK_MS);
  console.log(
    `[agent] heartbeat tick every ${HEARTBEAT_TICK_MS / 1000}s (with failure backoff up to 30min)`,
  );

  // Extract sweep: periodically re-queue any node that never got an
  // extractor_run (a node_ingested notify lost to a dropped listener / wedged
  // extraction), so a missed file self-heals in minutes instead of waiting for
  // a restart's boot-drain. Loop-safe + bounded (see sweepMissedExtractions).
  const SWEEP_INTERVAL_MS = Number(env('MANTLE_EXTRACT_SWEEP_MS')) || 120 * 1000;
  setInterval(() => {
    sweepMissedExtractions(owner).catch((err) =>
      console.error(
        '[agent] extract sweep error (will retry next tick):',
        err instanceof Error ? err.message : err,
      ),
    );
  }, SWEEP_INTERVAL_MS);
  console.log(`[agent] extract sweep every ${SWEEP_INTERVAL_MS / 1000}s (missed-event safety net)`);

  // Tables v2 migration sweep (plan §9): convert the long tail of legacy
  // JSONB tables to sqlite files, a few per tick, each under the same
  // registry lock every writer takes (so a sweep step can never fork against
  // a concurrent edit). Lazy migration (first op/commit) handles hot tables;
  // this catches the rest. No-op once storage_path is set everywhere.
  const TABLE_MIGRATE_SWEEP_MS = Number(env('MANTLE_TABLE_MIGRATE_SWEEP_MS')) || 5 * 60 * 1000;
  const TABLE_MIGRATE_BATCH = 5;
  setInterval(() => {
    sweepLegacyTables(TABLE_MIGRATE_BATCH).catch((err) =>
      console.error(
        '[agent] table migration sweep error (will retry next tick):',
        err instanceof Error ? err.message : err,
      ),
    );
  }, TABLE_MIGRATE_SWEEP_MS);
  console.log(
    `[agent] table migration sweep every ${TABLE_MIGRATE_SWEEP_MS / 1000}s (${TABLE_MIGRATE_BATCH}/tick)`,
  );

  await assertEmbeddingModelConsistency(owner);
  await drainPending(opts.enqueueTelegramTurn);
  await drainUnextractedNodes(owner);

  // Listeners + timers are now live; return so the host process (server/api)
  // stays alive via DBOS. Graceful extractor-queue shutdown is wired through
  // stopAgentRuntime() below, called from server/api's signal handler.
}

/**
 * Graceful stop for the absorbed agent runtime — drains the extractor queue so
 * in-flight pg-boss jobs finish (instead of being left `active` until the
 * maintenance reaper expires them). server/api's shutdown calls this alongside
 * DBOS.shutdown(). Idempotent via stopExtractQueue.
 */
export async function stopAgentRuntime(): Promise<void> {
  console.log('[agent] stopping extract queue');
  await stopExtractQueue();
}
