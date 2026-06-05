/**
 * Mantle agent. Listens on Postgres for `telegram_message_inserted` notifies
 * and replies via OpenRouter.
 *
 *   pg_notify (from migration 0009 trigger; only inbound rows now)
 *      ↓
 *   handleMessage(messageId)
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
  assistantMessages,
  channels,
  nodes,
  telegramMessages,
  telegramChats,
  telegramAccounts,
  waitForOwner,
  type Agent,
  type ConversationAttachment,
  type TelegramAccount,
} from '@mantle/db';
import { accountById, downloadTelegramFile, sendChatAction, sendMessage, sendVoice } from '@mantle/telegram';
import {
  buildIdentityContext,
  buildTimeContextLine,
  loadProfilePreferences,
} from '@mantle/content';
import { ensureDatedUploadFolder, upsertFile } from '@mantle/files';
import { getApiKey, getApiKeyById } from '@mantle/api-keys';
import {
  composeAudioTagInstructions,
  getChatAdapter,
  getSttAdapter,
  getTtsAdapter,
  stripAudioTags,
} from '@mantle/voice';
import {
  bumpWorkerUsage as bumpAiWorkerUsage,
  getDefaultWorker,
  getAgentTtsWorker,
  type AgentParams,
  type SttParams,
  type TelegramAttachment,
  type TtsParams,
} from '@mantle/db';
import { resolveEmbeddingConfig } from '@mantle/embeddings';
import { maxImageBytesFor, modelSupportsVision, recordIngest, refreshModelCatalog, startTrace, step } from '@mantle/tracing';
import {
  buildChatMessages,
  buildAttachmentContextText,
  composeSystemPromptWithSkills,
  effectiveToolSlugs,
  extractAttachmentForTurn,
  invokeAgent,
  loadConversationContext,
  recordTurn,
  resolveAgentSkills,
  resolveAgentToolGroups,
  resolveAgentTools,
  resolveBackupAdapter,
  resolveChatKey,
  runToolLoop,
  type UserImage,
} from '@mantle/agent-runtime';
import {
  registerAgentInvoker,
  seedBuiltinTools,
} from '@mantle/tools';
import {
  buildOpenHeartbeatContext,
  HEARTBEAT_DUE_CHANNEL,
  HEARTBEAT_RESPONDER_TOOLS,
  hasActiveHeartbeatsOnSurface,
  openHeartbeatsForSurface,
  registerHeartbeatTools,
  tickHeartbeats,
} from '@mantle/heartbeats';

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

// Resolved at the top of main() via waitForOwner() — either ALLOWED_USER_ID (when
// set) or the sole auth.users row. Left `undefined` until then so a fresh install
// can boot with an empty DB and the worker idles until the first signup, instead
// of exiting. Every consumer below runs after main() has resolved it.
let USER_ID: string | undefined = process.env.ALLOWED_USER_ID;
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('[agent] DATABASE_URL must be set');
  process.exit(1);
}

/** Per-chat in-flight tracker. Prevents two replies racing for the same chat. */
const inflight = new Map<string, Promise<void>>();

/** Native Telegram "typing…" keep-alive. Telegram clears a chat action
 *  after ~5s, so we re-send every 4s until the returned stop() is called.
 *  Best-effort: send failures are swallowed so they never break a turn. */
function startTyping(account: TelegramAccount, chatId: string): () => void {
  let stopped = false;
  const poke = () => {
    if (stopped) return;
    void sendChatAction(account, chatId, 'typing').catch(() => {});
  };
  poke();
  const timer = setInterval(poke, 4000);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

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

/** Telegram fills a media message's text with a placeholder like "(photo)" or
 *  "(document: report.pdf)" when there's no real caption. Treat those as empty
 *  so they don't become the user's "question". */
function telegramCaption(text: string | null | undefined): string {
  const t = (text ?? '').trim();
  if (!t || /^\((photo|document|voice message|audio|video|video_note|sticker)\b/i.test(t)) return '';
  return t;
}

/** Map a Telegram message's attachments to the unified conversation-stream
 *  shape so a turn renders its media in /assistant (Phase 5). `fileNodeId` is
 *  the ingested file node (photos/documents get one), surfaced so a future
 *  render can re-fetch the original. Stickers are dropped (no conversational
 *  value). Bytes are never stored — only the transport file_id + node id. */
function toConversationAttachments(
  atts: TelegramAttachment[] | null | undefined,
  fileNodeId?: string | null,
): ConversationAttachment[] {
  const KIND: Record<string, ConversationAttachment['kind'] | undefined> = {
    photo: 'image',
    document: 'document',
    voice: 'voice',
    audio: 'audio',
    video: 'video',
    video_note: 'video',
    sticker: undefined,
  };
  const out: ConversationAttachment[] = [];
  for (const a of atts ?? []) {
    const kind = KIND[a.kind];
    if (!kind) continue;
    out.push({
      kind,
      ...(a.mime ? { mime: a.mime } : {}),
      ...(a.name ? { caption: a.name } : {}),
      ...(a.file_id ? { fileId: a.file_id } : {}),
      ...(fileNodeId && (a.kind === 'photo' || a.kind === 'document') ? { nodeId: fileNodeId } : {}),
    });
  }
  return out;
}

async function handleMessage(messageId: string): Promise<void> {
  const [row] = await db
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

  if (!row) return;
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
    (a): a is TelegramAttachment & { file_id: string } =>
      a.kind === 'voice' && typeof a.file_id === 'string',
  );
  let wasVoice = false;
  let voiceFileId: string | null = null;
  if (voiceAttachment) {
    wasVoice = true;
    voiceFileId = voiceAttachment.file_id;
  }

  // Attachment branch — a photo OR a document. Save the bytes to /files, then
  // FALL THROUGH to the responder so Saskia can answer about it (parity with
  // the web /assistant). The bytes land as a real file node; the extractor
  // owns durable metadata; the responder gets the inline (question-aware)
  // extraction folded into its turn with the node id surfaced. The reply gets
  // its own responder_turn trace.
  const fileAttachment = (row.attachments ?? []).find(
    (a): a is TelegramAttachment & { file_id: string } =>
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
  const claim = await db
    .update(telegramMessages)
    .set({ processed: true, processedAt: new Date() })
    .where(and(eq(telegramMessages.id, row.id), eq(telegramMessages.processed, false)))
    .returning({ id: telegramMessages.id });
  if (claim.length === 0) return;

  // Ingest the attachment (if any) into a file node + inline extraction BEFORE
  // the responder runs. The save fires the extractor (durable metadata); this
  // inline pass is for the live reply only.
  let attachmentContext:
    | {
        kind: 'image' | 'file';
        transcript: string;
        note: string | null;
        nodeId: string | null;
        bytes: Buffer;
        mimeType: string;
      }
    | null = null;
  if (fileAttachment) {
    const isPhoto = fileAttachment.kind === 'photo';
    const caption = telegramCaption(row.text);
    attachmentContext = await startTrace(
      {
        kind: isPhoto ? 'photo_ingest' : 'content_ingest',
        ownerId: USER_ID!,
        subjectId: row.id,
        subjectKind: 'telegram_message',
        data: {
          telegramChatId: row.telegramChatId,
          fileId: fileAttachment.file_id,
          attachmentKind: fileAttachment.kind,
        },
      },
      async () => {
        const account = await accountById(row.accountId);
        if (!account) {
          console.error('[agent] no telegram account for attachment download', row.telegramChatId);
          return null;
        }
        let downloaded: Awaited<ReturnType<typeof downloadTelegramFile>>;
        try {
          downloaded = await step(
            { name: 'download_file', kind: 'compute', input: { fileId: fileAttachment.file_id } },
            async (h) => {
              const file = await downloadTelegramFile(account, fileAttachment.file_id);
              h.setMeta({ bytes: file.bytes.length, mime: file.mimeType });
              return file;
            },
          );
        } catch (err) {
          // Transient download failure (network / Telegram 5xx). Return null
          // so the caller can apologise instead of crashing the turn.
          console.error(
            '[agent] telegram attachment download failed:',
            err instanceof Error ? err.message : err,
          );
          return null;
        }

        // Documents declare their own name + mime; photos have neither, so
        // derive from the caption + detected mime.
        const mimeType = fileAttachment.mime || downloaded.mimeType;
        const ext = (mimeType.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '') || 'bin';
        const baseName =
          fileAttachment.name?.trim() ||
          `${
            (caption || (isPhoto ? 'photo' : 'file'))
              .toLowerCase()
              .replace(/[^\w-]+/g, '-')
              .slice(0, 60)
              .replace(/^-+|-+$/g, '') || (isPhoto ? 'photo' : 'file')
          }.${ext}`;

        // Save the bytes as a real file node first — even if extraction fails
        // we want the file persisted + searchable in /files.
        let nodeId: string | null = null;
        try {
          const parentPath = await ensureDatedUploadFolder({
            ownerId: USER_ID!,
            topSlug: 'telegram-uploads',
            topDescription: 'Files sent to Saskia on Telegram. Auto-created.',
          });
          const filename = `${Date.now()}-${baseName}`;
          const saved = await step({ name: 'persist_file', kind: 'db_write' }, async (h) => {
            const file = await upsertFile({
              ownerId: USER_ID!,
              parentPath,
              filename,
              bytes: downloaded.bytes,
              overwrite: false,
            });
            h.setMeta({ nodeId: file.id, filename, bytes: file.sizeBytes });
            return file;
          });
          nodeId = saved.id;
          void recordIngest({
            source: 'telegram_upload',
            ownerId: USER_ID!,
            nodeId: saved.id,
            summary: `${isPhoto ? 'Image' : 'File'} received via Telegram: ${filename}`,
            payload: {
              chatId: row.telegramChatId,
              telegramMessageId: row.telegramMessageId,
              filename,
              mimeType,
              sizeBytes: saved.sizeBytes,
            },
          });
        } catch (err) {
          console.error(
            '[agent] telegram attachment save failed:',
            err instanceof Error ? err.message : err,
          );
        }

        // Inline extraction for THIS turn's reply (question-aware vision for
        // images, doc parse for files) via the shared helper. Durable metadata
        // is the extractor's job, fired by the save above.
        const extract = await step(
          {
            name: 'extract_attachment',
            kind: 'llm_call',
            input: { mime: mimeType, bytes: downloaded.bytes.length, hasQuestion: caption.length > 0 },
          },
          async (h) => {
            const r = await extractAttachmentForTurn({
              ownerId: USER_ID!,
              bytes: downloaded.bytes,
              mimeType,
              filename: baseName,
              question: caption || undefined,
            });
            h.setMeta({ attachmentKind: r.kind, note: r.note, textLength: r.text.length });
            return r;
          },
        );

        return {
          kind: extract.kind === 'image' ? ('image' as const) : ('file' as const),
          transcript: extract.text,
          note: extract.note,
          nodeId,
          bytes: downloaded.bytes,
          mimeType,
        };
      },
    );
    // Couldn't fetch / ingest the attachment (no account, or a transient
    // download failure). The row is already claimed so we won't retry — at
    // least tell the user instead of going silent.
    if (!attachmentContext) {
      const account = await accountById(row.accountId).catch(() => null);
      if (account) {
        await sendMessage(
          account,
          row.telegramChatId,
          "Sorry — I couldn't fetch that file. Could you send it again?",
          { replyTo: row.telegramMessageId ?? undefined },
        ).catch(() => {});
      }
      return;
    }
  }

  // Resolve the responder + key BEFORE opening a trace. Failure modes here
  // (no agent, no key) don't generate traces — there's nothing useful to
  // record about "the system was misconfigured."
  const agent = await resolveResponderAgent(USER_ID!, row.responderAgentId, row.channelAgentId);
  if (!agent) {
    console.error(
      `[agent] no enabled responder agent — skipping ${messageId}. Create one at /settings/agents.`,
    );
    return;
  }
  // Resolve the responder's chat key via the shared resolver (keyless `local`
  // → 'local' sentinel; cloud → pinned/service key, else skip). Same single
  // source of truth the worker pre-flights + the dispatch path use.
  const keyCheck = await resolveChatKey(USER_ID!, agent);
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
        ownerId: USER_ID!,
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
        // ── 0. Transcribe voice (if any) BEFORE anything downstream
        // reads `row.text`. Failure here downgrades the turn to a
        // graceful text apology rather than crashing the trace.
        if (voiceFileId) {
          const transcript = await step(
            {
              name: 'transcribe_voice',
              kind: 'compute',
              input: { fileId: voiceFileId },
            },
            async (h) => {
              // Look up the configured STT worker. If one exists with an
              // api_key, use its provider + model + params. Otherwise
              // fall back to the bare 'service=openai' key for backwards-
              // compat with older setups that haven't migrated to
              // ai_workers yet (treats it as an OpenAI/Whisper call).
              const sttWorker = await getDefaultWorker(USER_ID!, 'stt');
              let apiKey: string | null = null;
              let providerId = 'openai';
              let model = 'whisper-1';
              let language: string | undefined;
              let maxDuration = 180;
              if (sttWorker?.apiKeyId) {
                apiKey = await getApiKeyById(sttWorker.apiKeyId);
                providerId = sttWorker.provider;
                model = sttWorker.model;
                const sttParams = (sttWorker.params ?? {}) as SttParams;
                language = sttParams.language;
                maxDuration = sttParams.max_duration_seconds ?? 180;
              } else {
                apiKey = await getApiKey(USER_ID!, 'openai');
              }
              if (!apiKey) {
                h.setMeta({ error: 'no openai api_key configured' });
                throw new Error(
                  'voice received but no OpenAI api_key configured. Either add an STT worker at /settings/ai-workers or add a bare openai key at /settings/api-keys.',
                );
              }
              const adapter = getSttAdapter(providerId);
              if (!adapter) {
                h.setMeta({ error: `no STT adapter for '${providerId}'` });
                throw new Error(
                  `STT provider '${providerId}' is not yet wired. Currently supported: openai. ` +
                    'Switch the STT worker to a wired provider at /settings/ai-workers.',
                );
              }
              const account = await accountById(row.accountId);
              if (!account) {
                throw new Error('no telegram account available for voice download');
              }
              const downloaded = await downloadTelegramFile(account, voiceFileId!);
              h.setMeta({
                bytes: downloaded.bytes.length,
                worker_slug: sttWorker?.slug ?? null,
                adapter: adapter.adapterName,
              });
              const result = await adapter.transcribe(downloaded.bytes, {
                apiKey,
                mimeType: downloaded.mimeType,
                model,
                language,
                maxDurationSeconds: maxDuration,
              });
              if (sttWorker) void bumpAiWorkerUsage(sttWorker.id);
              h.setOutput({
                model: result.model,
                language: result.language,
                durationSeconds: result.durationSeconds,
                chars: result.text.length,
              });
              return result;
            },
          ).catch((err) => {
            console.error(
              '[agent] voice transcription failed:',
              err instanceof Error ? err.message : err,
            );
            return null;
          });

          if (!transcript || !transcript.text) {
            // Soft-fail: send Saskia a text apology, stay coherent.
            const account = await accountById(row.accountId);
            if (account) {
              await sendMessage(
                account,
                row.telegramChatId,
                "Sorry love — I couldn't pick up that voice clip. Could you try again, or type it out?",
                { replyTo: row.telegramMessageId ?? undefined },
              );
            }
            return;
          }

          // Replace the placeholder text with the transcript so the
          // rest of the pipeline (load_context, history, embeddings,
          // extractor) sees real words. We update both the in-memory
          // row and the DB row so the assistant timeline and digest
          // generator find the actual content later.
          row.text = transcript.text;
          await db
            .update(telegramMessages)
            .set({
              text: transcript.text,
              attachments: (row.attachments ?? []).map((a) =>
                a.kind === 'voice'
                  ? {
                      ...a,
                      transcript: transcript.text,
                      transcript_model: transcript.model,
                      transcript_language: transcript.language,
                      duration_seconds: transcript.durationSeconds,
                    }
                  : a,
              ),
            })
            .where(eq(telegramMessages.id, row.id));
        }

        // Record the inbound turn into the unified per-(owner, agent)
        // conversation stream (assistant_messages, channel='telegram') — the
        // single source of truth the responder reads history from and the
        // summarizer rolls up. telegram_messages stays the transport/brain
        // record. Done HERE (not at poll time) because the responder agent is
        // only resolved now; the atomic processed-claim above guarantees this
        // runs exactly once per inbound. See docs/conversation.md.
        const convInbound = await recordTurn({
          ownerId: USER_ID!,
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
        });

        const { personaNotes, facts: relevantFacts, digests, contentHits, chunkHits, relations, history } =
          await step(
            { name: 'load_context', kind: 'compute', input: { agentId: agent.id } },
            async (h) => {
              const ctx = await loadConversationContext({
                ownerId: USER_ID!,
                agent,
                inboundText: row.text,
                // Exclude the inbound we just recorded; only look before it.
                excludeMessageId: convInbound.id,
                before: convInbound.createdAt,
              });
              h.setOutput({
                turnCount: ctx.history.length,
                digestCount: ctx.digests.length,
                factCount: ctx.facts.length,
                contentHitCount: ctx.contentHits.length,
                chunkHitCount: ctx.chunkHits.length,
                relationCount: ctx.relations.length,
                personaNoteCount: ctx.personaNotes.length,
              });
              return ctx;
            },
          );

        // Resolve attached skills early so we can compose the system
        // prompt + extend the agent's effective tool allowlist.
        const attachedSkills = await resolveAgentSkills(USER_ID!, agent.skillSlugs ?? []);
        // Prepend a one-line "current time + timezone + locale" so
        // Saskia can resolve relative references like "tomorrow at
        // 3pm" into a UTC ISO when calling event_create. Pure prompt
        // overhead is ~30 tokens per turn; the gain is correct
        // event scheduling without manual UTC math.
        const prefs = await loadProfilePreferences(USER_ID!);
        const promptWithTime = `${buildTimeContextLine(prefs)}\n\n${agent.systemPrompt}`;
        const promptWithSkills = composeSystemPromptWithSkills(
          promptWithTime,
          attachedSkills,
        );

        // Open-heartbeat awareness: if there are active heartbeats
        // for this Telegram chat with state.expecting_reply truthy,
        // append a small block so Saskia knows she's mid-conversation
        // with one of her own proactive tasks and should call
        // heartbeat_update_state after acting on the user's reply.
        // Heartbeat skills themselves are NOT loaded here (they're
        // only active during a heartbeat fire); this is just the
        // awareness layer that keeps continuity across the
        // outbound/inbound boundary. Best-effort: a DB failure here
        // shouldn't kill the turn. The block builder lives in
        // @mantle/heartbeats so the web /assistant uses the same
        // exact string (no drift).
        //
        // Wrapped in a step so /traces shows "this responder turn
        // was influenced by heartbeat X" — meta.related_slugs is
        // the operator's pivot point. (Audit P-trace-5.)
        let openHeartbeatBlock = '';
        try {
          const open = await step(
            {
              name: 'open_heartbeats_check',
              kind: 'db_read',
              input: { surface: 'telegram', chat_id: row.telegramChatId },
            },
            async (h) => {
              const rows = await openHeartbeatsForSurface(USER_ID!, {
                kind: 'telegram',
                chatId: row.telegramChatId,
              });
              h.setMeta({
                count: rows.length,
                related_slugs: rows.map((r) => r.slug),
              });
              return rows;
            },
          );
          const block = buildOpenHeartbeatContext(open);
          if (block) openHeartbeatBlock = `\n\n${block}`;
        } catch (err) {
          console.error(
            '[agent] open-heartbeat context skipped:',
            err instanceof Error ? err.message : err,
          );
        }

        // Tell Saskia which speech tags her configured TTS will honour:
        // inline cues (ElevenLabs v3 [laughs]/[sighs]; OpenAI none) AND
        // wrapping styles (xAI Grok <whisper>…</whisper>/<soft>/<slow>).
        // Looked up once per turn so the prompt stays current if the TTS
        // worker is swapped between turns. Empty paragraph if no TTS
        // worker, no tags-capable model, or no adapter — concat is a no-op.
        let audioTagInstructions = '';
        try {
          const ttsWorkerForTags = await getAgentTtsWorker(USER_ID!, agent.ttsWorkerId);
          if (ttsWorkerForTags) {
            const ttsAdapterForTags = getTtsAdapter(ttsWorkerForTags.provider);
            const tags =
              ttsAdapterForTags?.supportedAudioTags?.(ttsWorkerForTags.model) ?? [];
            const wrappingTags =
              ttsAdapterForTags?.supportedWrappingTags?.(ttsWorkerForTags.model) ?? [];
            audioTagInstructions = composeAudioTagInstructions(tags, wrappingTags);
          }
        } catch (err) {
          // Tag-injection is best-effort decoration. A DB blip here
          // shouldn't kill the turn.
          console.error(
            '[agent] audio-tag prompt injection skipped:',
            err instanceof Error ? err.message : err,
          );
        }
        // Always-on identity context — the "who you are" block distilled from
        // the user's Life Logs (deterministic, no LLM; empty when there are
        // none). Opt out per-agent with memory_config.inject_lifelog=false.
        // Prepended so it reads as durable user-truth at the top of the
        // (cached) system block. Mirrors the web /assistant path exactly.
        let identityBlock = '';
        if (
          (agent.memoryConfig as { inject_lifelog?: boolean } | null)?.inject_lifelog !== false
        ) {
          try {
            const block = await buildIdentityContext(USER_ID!);
            if (block) identityBlock = `${block}\n\n`;
          } catch (err) {
            console.error(
              '[agent] identity context skipped:',
              err instanceof Error ? err.message : err,
            );
          }
        }
        const effectiveSystemPrompt =
          identityBlock + promptWithSkills + openHeartbeatBlock + audioTagInstructions;

        // Attachment → responder input (transcript-default, mirroring web).
        // Prefer the inline-extracted text folded into the turn; for an IMAGE
        // with no transcript, fall back to inlining the raw pixels when the
        // model is vision-capable and within its size limit. The node id is
        // surfaced either way so Saskia can re-read it (extract_from_image /
        // file_read) on a follow-up.
        let responderUserText = row.text;
        let userImage: UserImage | undefined;
        if (attachmentContext) {
          // Warm the live model catalog so the vision check below reads
          // authoritative capability (architecture.input_modalities) rather
          // than the heuristic. Fire-and-forget + TTL-gated; the static
          // fallback covers the cold path.
          void refreshModelCatalog();
          const caption = telegramCaption(row.text);
          const baseText =
            caption ||
            (attachmentContext.kind === 'image'
              ? "Here's an image — tell me what you see."
              : "I've attached a file — take a look and tell me what's in it.");
          const hasTranscript = attachmentContext.transcript.trim().length > 0;
          const withinLimit = attachmentContext.bytes.length <= maxImageBytesFor(agent.model);
          if (
            attachmentContext.kind === 'image' &&
            !hasTranscript &&
            modelSupportsVision(agent.model) &&
            withinLimit
          ) {
            userImage = {
              base64: attachmentContext.bytes.toString('base64'),
              mimeType: attachmentContext.mimeType,
            };
            responderUserText = baseText;
          } else {
            responderUserText = buildAttachmentContextText(baseText, {
              kind: attachmentContext.kind,
              transcript: attachmentContext.transcript,
              note: attachmentContext.note,
              nodeId: attachmentContext.nodeId,
            });
          }
        }

        const messages = await step(
          { name: 'build_messages', kind: 'compute' },
          async (h) => {
            const m = buildChatMessages({
              model: agent.model,
              provider: agent.provider,
              systemPrompt: effectiveSystemPrompt,
              personaNotes,
              facts: relevantFacts,
              digests,
              contentHits,
              chunkHits,
              relations,
              history,
              newUserText: responderUserText,
              userImage,
            });
            h.setMeta({
              blockCount: m.length,
              skillCount: attachedSkills.length,
              hasImage: !!userImage,
            });
            return m;
          },
        );

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

        console.log(
          `[agent] → ${row.fromName ?? 'unknown'} via ${chatAdapter.adapterName}:${agent.model} (${row.text.length}c, ${history.length} turns, ${digests.length} digests, ${relevantFacts.length} facts, ${contentHits.length} content)`,
        );

        // Resolve the agent's tool allowlist from its granted tool groups (P6:
        // groups are the sole grant). Empty result → tool-loop sends no `tools`.
        //
        // Heartbeat continuity tools (update_state / complete / snooze) are a
        // per-turn AFFORDANCE (P6), not a stored grant: inject them only when
        // there's an active heartbeat on this surface for the model to act on.
        // No runtime magic the rest of the time — the model never sees (or
        // confusedly calls) heartbeat_* on turns with nothing to act on. See
        // docs/heartbeats.md §4 "Permission model & runtime hygiene".
        const groupTools = await resolveAgentToolGroups(USER_ID!, agent.toolGroupSlugs ?? []);
        let allowedToolSlugs = effectiveToolSlugs(groupTools);
        const hasHeartbeats = await hasActiveHeartbeatsOnSurface(USER_ID!, {
          kind: 'telegram',
          chatId: row.telegramChatId,
        }).catch(() => false);
        if (hasHeartbeats) {
          allowedToolSlugs = [
            ...allowedToolSlugs,
            ...HEARTBEAT_RESPONDER_TOOLS.filter((s) => !allowedToolSlugs.includes(s)),
          ];
        }
        const allowedTools = await resolveAgentTools(USER_ID!, allowedToolSlugs);

        const loopOutcome = await runToolLoop({
          adapter: chatAdapter,
          apiKey,
          model: agent.model,
          baseUrl: agent.baseUrl,
          viaTailnet: agent.viaTailnet,
          backup: await resolveBackupAdapter(USER_ID!, agent),
          params: (agent.params ?? {}) as AgentParams,
          ownerId: USER_ID!,
          agentId: agent.id,
          agentSlug: agent.slug,
          agentDepth: 1,
          delegateTo:
            (agent.memoryConfig as { delegate_to?: string[] } | null)?.delegate_to ?? [],
          resultHandling: agent.memoryConfig?.result_handling ?? null,
          initialMessages: messages,
          tools: allowedTools,
          // Surface lets worker-delegation tools (synthesize_speech,
          // etc.) target the right Telegram chat. The replyTo is the
          // message that triggered this turn so the bot's outbound
          // threads under it.
          surface: {
            kind: 'telegram',
            telegramChatId: row.telegramChatId,
            ...(row.telegramMessageId
              ? { replyToTelegramMessageId: row.telegramMessageId }
              : {}),
          },
        });
        const rawReply = loopOutcome.reply;
        if (!rawReply) {
          console.error('[agent] empty reply from model — not sending');
          return;
        }
        // Opt-in voice signal: Saskia (or any responder) can prefix her
        // reply with a `[VOICE]` token to force TTS-out even when the
        // user typed in. The token is stripped before send + persist so
        // it never reaches the user or the timeline. Match is permissive
        // (case-insensitive, optional whitespace) because LLMs love to
        // capitalise inconsistently. The marker has to be the FIRST
        // non-whitespace content — we don't want to scan mid-reply and
        // accidentally trigger on a quoted phrase.
        const voiceMarkerMatch = rawReply.match(/^\s*\[voice\]\s*/i);
        const requestedVoice = voiceMarkerMatch !== null;
        const reply = requestedVoice
          ? rawReply.slice(voiceMarkerMatch![0].length).trim()
          : rawReply;
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
        // emitted `[VOICE]` marker) opt in. There's no longer a
        // per-agent `params.voice.enabled` toggle — enable/disable
        // happens by enabling/disabling the TTS worker row.
        const replyAsVoice = wasVoice || requestedVoice;
        // Per-agent voice: use the TTS worker this agent pins (agent.ttsWorkerId),
        // else the owner's default TTS worker. getAgentTtsWorker handles the
        // unset / disabled / deleted cases by falling back to the default.
        const ttsWorker = replyAsVoice
          ? await getAgentTtsWorker(USER_ID!, agent.ttsWorkerId)
          : null;

        // Generate-then-send, but never lose the reply: if the send throws, the
        // send_telegram step still records the error and we persist the reply
        // below (flagged undelivered) so it stays recoverable, then fail the
        // trace so it surfaces in "Needs attention".
        let telegramMessageIds: number[] = [];
        let delivered = false;
        let sendError: string | null = null;
        try {
        telegramMessageIds = await step(
          { name: 'send_telegram', kind: 'send', input: { mode: replyAsVoice ? 'voice' : 'text' } },
          async (h) => {
            if (replyAsVoice && ttsWorker?.apiKeyId) {
              // Synthesise inside the same step so cost + meta roll up
              // here. We catch and fall through to text on failure so
              // a transient OpenAI hiccup doesn't drop the reply.
              try {
                const ttsApiKey = await getApiKeyById(ttsWorker.apiKeyId);
                if (!ttsApiKey) {
                  throw new Error(
                    `tts worker '${ttsWorker.slug}' api key not found`,
                  );
                }
                // Resolve the provider-specific adapter. If the worker
                // is configured for a provider we haven't wired yet
                // (e.g. elevenlabs before its adapter ships), refuse
                // here rather than guessing — better an explicit
                // error in the trace than a silently mangled call.
                const ttsAdapter = getTtsAdapter(ttsWorker.provider);
                if (!ttsAdapter) {
                  throw new Error(
                    `no TTS adapter for provider '${ttsWorker.provider}' — switch the worker to a wired provider (openai)`,
                  );
                }
                const ttsParams = (ttsWorker.params ?? {}) as TtsParams;
                const synth = await ttsAdapter.synthesize({
                  apiKey: ttsApiKey,
                  text: reply,
                  // Cast through unknown — voice is a free-form string
                  // at the storage layer (xAI / ElevenLabs accept
                  // custom voice ids like '69smp8rm'), but
                  // SynthesizeOptions.voice is typed as the OpenAI
                  // union. Adapter does per-provider validation.
                  voice: (ttsParams.voice ?? 'nova') as never,
                  // Worker.model wins; ttsParams.model is a redundant
                  // alias on the OpenAI side but other providers may
                  // split voice from model — keep both lookups.
                  model: ttsWorker.model || ttsParams.model || 'gpt-4o-mini-tts',
                  speed: ttsParams.speed ?? 1.0,
                  format: 'opus', // Telegram-native — sendVoice bubble
                  // Style instructions only land on gpt-4o-mini-tts;
                  // older models ignore the field silently, so it's
                  // safe to forward unconditionally.
                  instructions: ttsParams.instructions,
                  // Language hint — drives accent on xAI custom
                  // voices (e.g. setting 'fr' to keep a French clone's
                  // accent regardless of input text). Other providers
                  // ignore.
                  language: ttsParams.language,
                });
                const voiceMessageId = await sendVoice(
                  account,
                  row.telegramChatId,
                  synth.bytes,
                  { replyTo: row.telegramMessageId ?? undefined },
                );
                void bumpAiWorkerUsage(ttsWorker.id);
                h.setMeta({
                  mode: 'voice',
                  voice: synth.voice,
                  ttsModel: synth.model,
                  adapter: ttsAdapter.adapterName,
                  workerSlug: ttsWorker.slug,
                  audioBytes: synth.bytes.length,
                  replyLength: reply.length,
                });
                return [voiceMessageId];
              } catch (err) {
                console.error(
                  '[agent] tts failed, falling back to text:',
                  err instanceof Error ? err.message : err,
                );
                h.setMeta({ ttsFallback: true });
                // Fall through to text path below.
              }
            }
            // Strip any audio tags Saskia emitted — they only make
            // sense in a voice context. If the reply ends up here
            // (text-out, or TTS fallback after failure), bracketed
            // tags would otherwise appear as literal text.
            const { text: textReply, stripped } = stripAudioTags(reply);
            const ids = await sendMessage(account, row.telegramChatId, textReply, {
              replyTo: row.telegramMessageId ?? undefined,
            });
            h.setMeta({
              mode: 'text',
              chunks: ids.length,
              replyLength: textReply.length,
              ...(stripped > 0 ? { audioTagsStripped: stripped } : {}),
            });
            return ids;
          },
        );
        delivered = true;
        } catch (err) {
          // The send_telegram step already recorded the error; capture it and
          // fall through to persist so the generated reply isn't lost.
          sendError = err instanceof Error ? err.message : String(err);
        }

        await step({ name: 'persist_outbound', kind: 'db_write' }, async (h) => {
          const now = new Date();
          const titleStem = reply.slice(0, 120);
          // Delivered → one row per sent chunk (with its Telegram id). Failed →
          // a single row with a null id, flagged undelivered (recoverable).
          const targets: (number | null)[] = delivered ? telegramMessageIds : [null];
          for (const tgMsgId of targets) {
            const [node] = await db
              .insert(nodes)
              .values({
                ownerId: USER_ID!,
                type: 'telegram_message',
                title: titleStem,
                path: account.branchPath,
                data: {
                  direction: 'outbound',
                  model: agent.model,
                  agent: agent.slug,
                  replyToTelegramMessageId: row.telegramMessageId,
                  delivered,
                },
                tags: ['telegram', 'outbound'],
              })
              .returning({ id: nodes.id });
            if (!node) throw new Error('failed to create outbound node');

            await db.insert(telegramMessages).values({
              nodeId: node.id,
              accountId: row.accountId,
              chatId: row.chatPk,
              telegramMessageId: tgMsgId == null ? null : String(tgMsgId),
              text: reply,
              sentAt: now,
              direction: 'outbound',
              agentId: agent.id,
              modelUsed: agent.model,
              replyToId: row.id,
              delivered,
              processed: true,
              processedAt: now,
            });
          }

          // Mirror the outbound into the unified per-agent stream ONCE (the
          // full reply text — the per-chunk telegram_messages rows above are
          // the transport record). channel='telegram'; external_ref points at
          // the first sent chunk for reply threading. See docs/conversation.md.
          await recordTurn({
            ownerId: USER_ID!,
            agentId: agent.id,
            direction: 'outbound',
            text: reply,
            channel: 'telegram',
            model: agent.model,
            externalRef: {
              accountId: row.accountId,
              chatId: row.telegramChatId,
              ...(delivered && telegramMessageIds[0] != null
                ? { messageId: String(telegramMessageIds[0]) }
                : {}),
            },
          });
          h.setMeta({ rows: targets.length, delivered, ...(sendError ? { sendError } : {}) });
        });

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

        if (delivered) {
          console.log(`[agent] ✓ replied (${reply.length}c)`);
        } else {
          console.warn(`[agent] reply saved but Telegram send failed: ${sendError}`);
          // The reply is already persisted above (undelivered); fail the trace
          // here so the delivery failure surfaces without losing the reply.
          throw new Error(`reply generated + saved but Telegram send failed: ${sendError}`);
        }
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[agent] handle failed:', msg);
  } finally {
    stopTyping();
    release();
    if (inflight.get(lockKey) === lockPromise) {
      inflight.delete(lockKey);
    }
  }
}

async function drainPending(): Promise<void> {
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
  const healedCount = Array.isArray(healed) ? healed.length : (healed as { count?: number }).count ?? 0;
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
  for (const r of rows) {
    await handleMessage(r.id);
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
async function drainUnextractedNodes(): Promise<void> {
  const windowHours = Number(process.env.MANTLE_EXTRACT_DRAIN_WINDOW_HOURS) || 168;
  const limit = Number(process.env.MANTLE_EXTRACT_DRAIN_LIMIT) || 1000;
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);
  const conds = and(
    eq(nodes.ownerId, USER_ID!),
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
async function sweepMissedExtractions(): Promise<void> {
  const windowHours = Number(process.env.MANTLE_EXTRACT_DRAIN_WINDOW_HOURS) || 168;
  const limit = Number(process.env.MANTLE_EXTRACT_SWEEP_LIMIT) || 200;
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);
  const rows = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, USER_ID!),
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
async function assertEmbeddingModelConsistency(): Promise<void> {
  try {
    const config = await resolveEmbeddingConfig(USER_ID!);
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

function scheduleSummarize(agentId: string): void {
  summarizePending.add(agentId);
  if (summarizeTimer) return;
  summarizeTimer = setTimeout(() => {
    summarizeTimer = null;
    const batch = [...summarizePending];
    summarizePending.clear();
    for (const id of batch) {
      summarizeAgentConversation(USER_ID!, id).catch((err) =>
        console.error('[agent] summarize error:', err instanceof Error ? err.message : err),
      );
    }
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

async function main() {
  const pg = postgres(DATABASE_URL!, { max: 2 });
  console.log('[agent] starting — config from agents table');

  // Resolve the owner before any owner-scoped work. On a fresh install this
  // blocks until the first account is created in the web app (signup), then
  // proceeds — no ALLOWED_USER_ID env edit, no restart.
  USER_ID = await waitForOwner({ label: 'agent' });

  // Seed / refresh built-in tool definitions for this owner. Idempotent —
  // updates name/description/schema on each boot so registry edits in
  // packages/tools/src/builtins.ts propagate without manual DB work.
  try {
    const seedResult = await seedBuiltinTools(USER_ID!);
    console.log(
      `[agent] tools: ${seedResult.inserted} inserted, ${seedResult.updated} updated`,
    );
  } catch (err) {
    console.error(
      '[agent] tool seed failed:',
      err instanceof Error ? err.message : err,
    );
  }

  // Grant the core capability FLOOR (persona self-edit + todo CRUD etc., as
  // tool GROUPS) to the conversational agents so "be more professional" / "add
  // a todo" work without manual /settings/tools setup. Idempotent (P6).
  try {
    const granted = await ensureCoreToolsOnConversationalAgents(USER_ID!);
    if (granted.length > 0) {
      console.log(`[agent] core tools granted to: ${granted.join(', ')}`);
    }
  } catch (err) {
    console.error(
      '[agent] core tool grant failed:',
      err instanceof Error ? err.message : err,
    );
  }

  await pg.listen('telegram_message_inserted', (payload: string) => {
    if (!payload) return;
    handleMessage(payload).catch((err) =>
      console.error('[agent] handle error:', err instanceof Error ? err.message : err),
    );
  });
  console.log('[agent] LISTENing on telegram_message_inserted');

  // summarize_due now carries an AGENT id (migration 0072: AFTER INSERT on
  // assistant_messages, every channel), so one handler drives summarization
  // for web + Telegram + any future channel. The retired summarize_web_due
  // channel is no longer listened on.
  await pg.listen('summarize_due', (payload: string) => {
    if (!payload) return;
    scheduleSummarize(payload);
  });
  console.log('[agent] LISTENing on summarize_due (per-agent)');

  // Durable, concurrency-capped extractor queue. Must start BEFORE the
  // node_ingested listener (so enqueues land) and before the boot drain below.
  await startExtractQueue(DATABASE_URL!, USER_ID!);

  await pg.listen('node_ingested', (payload: string) => {
    if (!payload) return;
    enqueueExtract(payload).catch((err) =>
      console.error('[agent] enqueue extract error:', err instanceof Error ? err.message : err),
    );
  });
  console.log('[agent] LISTENing on node_ingested');

  // NEW-7: low-latency heartbeat wake. createHeartbeat + force-fire
  // paths fire pg_notify('heartbeat_due', ownerId). When we get one,
  // call tickHeartbeats(USER_ID) immediately — same code path as the
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
    // always USER_ID; we still pass it through for cleanliness.
    tickHeartbeats(payload).catch((err) =>
      console.error(
        `[agent] heartbeat_due wake error:`,
        err instanceof Error ? err.message : err,
      ),
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
    reflect(USER_ID!)
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
  console.log(`[agent] reflector tick every ${REFLECTOR_INTERVAL_MS / 1000}s (with failure backoff up to 1h)`);

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
    tickHeartbeats(USER_ID!)
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
  console.log(`[agent] heartbeat tick every ${HEARTBEAT_TICK_MS / 1000}s (with failure backoff up to 30min)`);

  // Extract sweep: periodically re-queue any node that never got an
  // extractor_run (a node_ingested notify lost to a dropped listener / wedged
  // extraction), so a missed file self-heals in minutes instead of waiting for
  // a restart's boot-drain. Loop-safe + bounded (see sweepMissedExtractions).
  const SWEEP_INTERVAL_MS = Number(process.env.MANTLE_EXTRACT_SWEEP_MS) || 120 * 1000;
  setInterval(() => {
    sweepMissedExtractions().catch((err) =>
      console.error('[agent] extract sweep error (will retry next tick):', err instanceof Error ? err.message : err),
    );
  }, SWEEP_INTERVAL_MS);
  console.log(`[agent] extract sweep every ${SWEEP_INTERVAL_MS / 1000}s (missed-event safety net)`);

  // Stop the extractor queue gracefully on shutdown so in-flight jobs finish
  // (and aren't left `active` in pgboss until the maintenance reaper expires
  // them). Registered once; the handler is idempotent via stopExtractQueue.
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      console.log(`[agent] ${sig} — stopping extract queue`);
      stopExtractQueue().finally(() => process.exit(0));
    });
  }

  await assertEmbeddingModelConsistency();
  await drainPending();
  await drainUnextractedNodes();

  await new Promise<never>(() => {});
}

// Backstop: every LISTEN handler and setInterval above already routes its
// errors through .catch() (the reflector + heartbeat ticks even back off),
// but a rejection that slips past should log and keep the agent alive rather
// than crash-loop on a transient PostgresError (e.g. Postgres restarted and
// briefly dropped connections). Docker would bounce us anyway; staying up is
// strictly better — the listeners auto-resubscribe and the next tick recovers.
process.on('unhandledRejection', (reason) => {
  console.error('[agent] unhandledRejection (kept alive):', reason);
});

main().catch((err) => {
  console.error('[agent] fatal:', err);
  process.exit(1);
});
