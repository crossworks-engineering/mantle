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
import { OpenRouter } from '@openrouter/sdk';
import { and, asc, desc, eq, gte, isNull, lt, ne, sql } from 'drizzle-orm';
import {
  db,
  agents,
  entities,
  facts,
  nodes,
  telegramMessages,
  telegramChats,
  type Agent,
  type AgentMemoryConfig,
  type PersonaNote,
} from '@mantle/db';
import { accountForChat, downloadTelegramFile, sendMessage, sendVoice } from '@mantle/telegram';
import { buildTimeContextLine, createNote, loadProfilePreferences } from '@mantle/content';
import { getApiKey, getApiKeyById } from '@mantle/api-keys';
import {
  composeAudioTagInstructions,
  getSttAdapter,
  getTtsAdapter,
  getVisionAdapter,
  stripAudioTags,
} from '@mantle/voice';
import {
  bumpWorkerUsage as bumpAiWorkerUsage,
  getDefaultWorker,
  type SttParams,
  type TelegramAttachment,
  type TtsParams,
} from '@mantle/db';
import { embed } from '@mantle/embeddings';
import { recordIngest, startTrace, step } from '@mantle/tracing';
import {
  buildChatMessages,
  composeSystemPromptWithSkills,
  effectiveToolSlugs,
  invokeAgent,
  resolveAgentSkills,
  resolveAgentTools,
  runToolLoop,
  type ContentHit,
  type Digest,
  type FactSnippet,
  type HistoryTurn,
} from '@mantle/agent-runtime';
import { registerAgentInvoker, seedBuiltinTools } from '@mantle/tools';
import {
  buildOpenHeartbeatContext,
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
import { summarizeChat } from './summarizer.js';
import { extractNode } from './extractor.js';
import { reflect } from './reflector.js';

const USER_ID = process.env.ALLOWED_USER_ID;
const DATABASE_URL = process.env.DATABASE_URL;

if (!USER_ID) {
  console.error('[agent] ALLOWED_USER_ID must be set');
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error('[agent] DATABASE_URL must be set');
  process.exit(1);
}

/** Per-chat in-flight tracker. Prevents two replies racing for the same chat. */
const inflight = new Map<string, Promise<void>>();

/** Fetch the active responder agent for a chat.
 *
 *  Resolution order:
 *    1. If the chat has `responder_agent_id` set AND that agent is enabled
 *       AND its role is responder/assistant/custom, use it. (Custom because
 *       a user may have pinned a one-off agent to a single chat.)
 *    2. Otherwise fall back to the highest-priority enabled responder
 *       (the global default).
 */
async function resolveResponderAgent(
  ownerId: string,
  overrideAgentId: string | null,
): Promise<Agent | null> {
  if (overrideAgentId) {
    const [pinned] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, overrideAgentId), eq(agents.ownerId, ownerId), eq(agents.enabled, true)))
      .limit(1);
    if (pinned) return pinned;
    // Override exists in DB but agent disabled/missing → fall through to global default.
  }
  const [row] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.ownerId, ownerId), eq(agents.role, 'responder'), eq(agents.enabled, true)))
    .orderBy(desc(agents.priority))
    .limit(1);
  return row ?? null;
}

/** Load everything the responder needs for its prompt:
 *    persona_notes + facts + digests + content_index hits + raw turns.
 *  Facts and content hits are vector-keyed off the incoming message, so we
 *  embed the user's text once and reuse it. */
async function loadContext(
  chatPk: string,
  excludeInboundId: string,
  inboundSentAt: Date,
  inboundText: string,
  agent: Agent,
  ownerId: string,
): Promise<{
  personaNotes: PersonaNote[];
  facts: FactSnippet[];
  digests: Digest[];
  contentHits: ContentHit[];
  turns: HistoryTurn[];
}> {
  const memoryConfig = (agent.memoryConfig ?? {}) as AgentMemoryConfig;
  const historyLimit = memoryConfig.history_limit ?? 20;
  const windowHours = memoryConfig.history_window_hours ?? null;
  const digestLimit = memoryConfig.digest_limit ?? 3;
  const factLimit = memoryConfig.fact_limit ?? 10;
  const contentHitLimit = memoryConfig.content_hit_limit ?? 3;
  const embeddingModel = memoryConfig.embedding_model;

  const personaNotes: PersonaNote[] = (agent.personaNotes ?? []) as PersonaNote[];

  // Embed once for both fact + content_index lookups. Skip if either limit is 0.
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
        '[agent] loadContext: query embed failed:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ─── Profile facts ──────────────────────────────────────────────────
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
    factRows = rows.map((r) => ({
      content: r.content,
      kind: r.kind as string,
      entityName: r.entityName,
    }));
  }

  // ─── Content index hits ────────────────────────────────────────────
  let contentHits: ContentHit[] = [];
  if (queryVec && contentHitLimit > 0) {
    const rows = await db
      .select({
        nodeId: nodes.id,
        title: nodes.title,
        type: nodes.type,
        data: nodes.data,
        dist: sql<number>`${nodes.embedding} <=> ${JSON.stringify(queryVec)}::vector`,
      })
      .from(nodes)
      .where(
        and(
          eq(nodes.ownerId, ownerId),
          sql`${nodes.embedding} is not null`,
          // Exclude conversation-digest notes (already covered by digest layer)
          // and telegram_message rows (those are the conversation itself).
          sql`not (${nodes.tags} @> ARRAY['conversation-digest']::text[])`,
          sql`${nodes.type} <> 'telegram_message'`,
        ),
      )
      .orderBy(sql`${nodes.embedding} <=> ${JSON.stringify(queryVec)}::vector`)
      .limit(contentHitLimit);
    contentHits = rows
      .filter((r) => (r.dist ?? 1) < 0.6) // cosine distance — exclude obvious non-matches
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

  // ─── Conversation digests for this chat ────────────────────────────
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
              sql`${nodes.data}->>'chat_id' = ${chatPk}`,
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

  // ─── Raw recent turns ──────────────────────────────────────────────
  const conds = [eq(telegramMessages.chatId, chatPk), ne(telegramMessages.id, excludeInboundId)];
  conds.push(lt(telegramMessages.sentAt, inboundSentAt));
  if (windowHours != null && windowHours > 0) {
    const cutoff = new Date(inboundSentAt.getTime() - windowHours * 3600_000);
    conds.push(gte(telegramMessages.sentAt, cutoff));
  }
  const rows = await db
    .select({
      direction: telegramMessages.direction,
      text: telegramMessages.text,
      sentAt: telegramMessages.sentAt,
    })
    .from(telegramMessages)
    .where(and(...conds))
    .orderBy(desc(telegramMessages.sentAt))
    .limit(historyLimit);
  const turns: HistoryTurn[] = rows
    .reverse()
    .map((r) => ({ role: r.direction === 'outbound' ? 'assistant' : 'user', text: r.text }));

  return { personaNotes, facts: factRows, digests, contentHits, turns };
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
      attachments: telegramMessages.attachments,
    })
    .from(telegramMessages)
    .innerJoin(telegramChats, eq(telegramMessages.chatId, telegramChats.id))
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

  // Photo branch — when a Telegram message has an image attachment we
  // route it through the default vision worker, save the extracted
  // text as a note, and send a short ack back to the user. This is a
  // SHORT-CIRCUIT: the responder LLM is not invoked. The default
  // extraction prompt is verbatim transcription (see VisionFields in
  // the worker form), which is exactly what you want for "photo of
  // my notes → searchable note." Operators who want a conversational
  // photo reply can re-route by editing the worker's prompt and
  // we'll layer that on later.
  //
  // text+photo: the caption (`row.text`) becomes the note title and
  // is appended to the prompt so the LLM has context. We still skip
  // the responder — the photo's the primary signal here.
  const photoAttachment = (row.attachments ?? []).find(
    (a): a is TelegramAttachment & { file_id: string } =>
      a.kind === 'photo' && typeof a.file_id === 'string',
  );
  if (photoAttachment) {
    // Atomic claim — same pattern as the main path so a duplicate
    // notify can't double-ingest the photo.
    const claim = await db
      .update(telegramMessages)
      .set({ processed: true, processedAt: new Date() })
      .where(and(eq(telegramMessages.id, row.id), eq(telegramMessages.processed, false)))
      .returning({ id: telegramMessages.id });
    if (claim.length === 0) return;

    await startTrace(
      {
        kind: 'photo_ingest',
        ownerId: USER_ID!,
        subjectId: row.id,
        subjectKind: 'telegram_message',
        data: {
          telegramChatId: row.telegramChatId,
          fileId: photoAttachment.file_id,
        },
      },
      async () => {
        const visionWorker = await getDefaultWorker(USER_ID!, 'vision');
        if (!visionWorker?.apiKeyId) {
          const account = await accountForChat(row.telegramChatId);
          if (account) {
            await sendMessage(
              account,
              row.telegramChatId,
              "I saw a photo but I don't have a vision worker configured yet. Add one at /settings/ai-workers and set it as the default for 'vision'.",
              { replyTo: row.telegramMessageId ?? undefined },
            );
          }
          return;
        }
        const adapter = getVisionAdapter(visionWorker.provider);
        if (!adapter) {
          const account = await accountForChat(row.telegramChatId);
          if (account) {
            await sendMessage(
              account,
              row.telegramChatId,
              `Vision provider '${visionWorker.provider}' isn't wired yet. Switch the default vision worker to openai / anthropic / google / xai.`,
              { replyTo: row.telegramMessageId ?? undefined },
            );
          }
          return;
        }
        const apiKey = await getApiKeyById(visionWorker.apiKeyId);
        if (!apiKey) {
          console.error(
            `[agent] vision worker '${visionWorker.slug}' api_key_id ${visionWorker.apiKeyId} not found.`,
          );
          return;
        }

        // Download the photo. Telegram's "best" size is what sync.ts
        // already picked (last entry in the photo array) so we don't
        // need to do thumbnail/scale logic here.
        const downloaded = await step(
          {
            name: 'download_photo',
            kind: 'compute',
            input: { fileId: photoAttachment.file_id },
          },
          async (h) => {
            const account = await accountForChat(row.telegramChatId);
            if (!account) throw new Error('no telegram account for photo download');
            const file = await downloadTelegramFile(account, photoAttachment.file_id);
            h.setMeta({ bytes: file.bytes.length, mime: file.mimeType });
            return file;
          },
        );

        // Vision extraction. The worker's params carry the per-image
        // prompt; we fall back to a verbatim default if it's blank.
        // text+photo case: append the caption so the model knows
        // what the user said about the image.
        const visionParams = (visionWorker.params ?? {}) as {
          extraction_prompt?: string;
          max_tokens?: number;
        };
        const basePrompt =
          visionParams.extraction_prompt?.trim() ||
          'Transcribe everything visible in this image verbatim, preserving line breaks and structure. If something is unclear, mark it [unclear]. Output plain text only — do not summarise or comment.';
        const caption = row.text && row.text !== '(photo)' ? row.text.trim() : '';
        const prompt = caption
          ? `${basePrompt}\n\nUser's caption: ${caption}`
          : basePrompt;

        const extracted = await step(
          {
            name: 'extract_vision',
            kind: 'llm_call',
            input: {
              workerSlug: visionWorker.slug,
              provider: visionWorker.provider,
              model: visionWorker.model,
              mime: downloaded.mimeType,
              bytes: downloaded.bytes.length,
            },
          },
          async (h) => {
            const result = await adapter.extract(downloaded.bytes, {
              apiKey,
              mimeType: downloaded.mimeType,
              prompt,
              systemPrompt: visionWorker.systemPrompt ?? undefined,
              model: visionWorker.model,
              maxTokens: visionParams.max_tokens ?? 2000,
            });
            h.setMeta({
              adapter: adapter.adapterName,
              tokensIn: result.tokensIn,
              tokensOut: result.tokensOut,
              textLength: result.text.length,
            });
            return result;
          },
        );
        void bumpAiWorkerUsage(visionWorker.id);

        // If the extraction returned nothing useful, don't create an
        // empty note — just tell the user. This usually means the
        // model refused (e.g. NSFW guard) or the image was blank.
        if (!extracted.text || extracted.text.length === 0) {
          const account = await accountForChat(row.telegramChatId);
          if (account) {
            await sendMessage(
              account,
              row.telegramChatId,
              "Got the photo, but I couldn't extract any text from it. (Worker: " +
                visionWorker.slug +
                '.)',
              { replyTo: row.telegramMessageId ?? undefined },
            );
          }
          return;
        }

        // Persist as a note. Title: caption if present, else a short
        // stem of the extracted text. The extractor + embedder
        // pipelines already watch for new nodes and will run over
        // this row asynchronously — that's the "embed" half of
        // "extract and embed" the user asked for.
        const title =
          caption.length > 0
            ? caption.slice(0, 120)
            : extracted.text.slice(0, 80).split(/\n/)[0]?.trim() || 'Photo notes';
        const note = await step(
          { name: 'persist_note', kind: 'db_write' },
          async (h) => {
            const created = await createNote(USER_ID!, {
              title,
              content: extracted.text,
              tags: ['telegram', 'photo', 'vision'],
            });
            h.setMeta({ noteId: created.id, title });
            return created;
          },
        );
        // Emit a content_ingest trace tied to the NEW NOTE id (the
        // surrounding photo_ingest trace is tied to the telegram
        // message). The note-biography view filters by subject_id;
        // this is what makes the photo-derived note discoverable as
        // "came in via Telegram photo at HH:MM" without parsing
        // the photo_ingest trace data jsonb.
        void recordIngest({
          source: 'telegram_photo',
          ownerId: USER_ID!,
          nodeId: note.id,
          summary: `Note created from Telegram photo: ${title}`,
          payload: {
            chatId: row.telegramChatId,
            telegramMessageId: row.telegramMessageId,
            visionAdapter: adapter.adapterName,
            visionModel: extracted.model,
            extractedChars: extracted.text.length,
          },
          snippet: extracted.text,
        });

        // Acknowledge to the user so they know the ingest worked.
        // Keep it short — they don't need the full transcript echoed
        // back; that's what /files/notes is for. Show the title and
        // a length hint so they can verify the right thing got saved.
        const account = await accountForChat(row.telegramChatId);
        if (account) {
          const ack =
            `Saved your photo as a note: "${title}" ` +
            `(${extracted.text.length} chars extracted via ${adapter.adapterName}).`;
          await sendMessage(account, row.telegramChatId, ack, {
            replyTo: row.telegramMessageId ?? undefined,
          });
        }
      },
    );
    return;
  }

  // If there's no useful text AND no voice → sticker/etc., nothing
  // to reply to. Skip the trace overhead, mark processed, done.
  const textIsEmpty = !row.text || !row.text.trim() || row.text === '(voice message)';
  if (textIsEmpty && !wasVoice) {
    await db
      .update(telegramMessages)
      .set({ processed: true, processedAt: new Date() })
      .where(eq(telegramMessages.id, row.id));
    return;
  }

  // Atomic claim. Flip processed=true BEFORE doing any work; if the row was
  // already claimed (by a prior invocation that crashed mid-reply, or by a
  // racing notify in another process), the UPDATE returns 0 rows and we
  // exit silently. Tradeoff: a crash between this UPDATE and the actual
  // Telegram send means the user gets no reply — but they don't get a
  // duplicate either, which is the more user-friendly failure mode on a
  // chat surface. Hot-reload-driven duplicates were the original symptom.
  const claim = await db
    .update(telegramMessages)
    .set({ processed: true, processedAt: new Date() })
    .where(and(eq(telegramMessages.id, row.id), eq(telegramMessages.processed, false)))
    .returning({ id: telegramMessages.id });
  if (claim.length === 0) return;

  // Resolve the responder + key BEFORE opening a trace. Failure modes here
  // (no agent, no key) don't generate traces — there's nothing useful to
  // record about "the system was misconfigured."
  const agent = await resolveResponderAgent(USER_ID!, row.responderAgentId);
  if (!agent) {
    console.error(
      `[agent] no enabled responder agent — skipping ${messageId}. Create one at /settings/agents.`,
    );
    return;
  }
  if (!agent.apiKeyId) {
    console.error(
      `[agent] responder agent '${agent.slug}' has no api_key_id set — skipping. Edit it at /settings/agents.`,
    );
    return;
  }
  const apiKey = await getApiKeyById(agent.apiKeyId);
  if (!apiKey) {
    console.error(
      `[agent] api_key_id ${agent.apiKeyId} for agent '${agent.slug}' has no entry — was it deleted?`,
    );
    return;
  }

  const lockKey = row.telegramChatId;
  const prev = inflight.get(lockKey);
  let release: () => void = () => {};
  const lockPromise = new Promise<void>((res) => {
    release = res;
  });
  if (prev) await prev;
  inflight.set(lockKey, lockPromise);

  try {
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
              const account = await accountForChat(row.telegramChatId);
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
            const account = await accountForChat(row.telegramChatId);
            if (account) {
              await sendMessage(
                account,
                row.telegramChatId,
                "Sorry love — I couldn't pick up that voice clip. Could you try again, or type it out?",
                { replyTo: row.telegramMessageId },
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

        const { personaNotes, facts: relevantFacts, digests, contentHits, turns: history } =
          await step(
            { name: 'load_context', kind: 'compute', input: { chatId: row.chatPk } },
            async (h) => {
              const ctx = await loadContext(
                row.chatPk,
                row.id,
                row.sentAt,
                row.text,
                agent,
                USER_ID!,
              );
              h.setOutput({
                turnCount: ctx.turns.length,
                digestCount: ctx.digests.length,
                factCount: ctx.facts.length,
                contentHitCount: ctx.contentHits.length,
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

        // Tell Saskia which inline audio tags her configured TTS will
        // honour (e.g. ElevenLabs v3 supports [laughs] / [whispers] /
        // [sighs]; OpenAI doesn't). Looked up once per turn so the
        // prompt stays current if the TTS worker is swapped between
        // turns. Empty paragraph if no TTS worker, no tags-capable
        // model, or no adapter — concat is a no-op.
        let audioTagInstructions = '';
        try {
          const ttsWorkerForTags = await getDefaultWorker(USER_ID!, 'tts');
          if (ttsWorkerForTags) {
            const ttsAdapterForTags = getTtsAdapter(ttsWorkerForTags.provider);
            const tags =
              ttsAdapterForTags?.supportedAudioTags?.(ttsWorkerForTags.model) ?? [];
            audioTagInstructions = composeAudioTagInstructions(tags);
          }
        } catch (err) {
          // Tag-injection is best-effort decoration. A DB blip here
          // shouldn't kill the turn.
          console.error(
            '[agent] audio-tag prompt injection skipped:',
            err instanceof Error ? err.message : err,
          );
        }
        const effectiveSystemPrompt =
          promptWithSkills + openHeartbeatBlock + audioTagInstructions;

        const messages = await step(
          { name: 'build_messages', kind: 'compute' },
          async (h) => {
            const m = buildChatMessages({
              model: agent.model,
              systemPrompt: effectiveSystemPrompt,
              personaNotes,
              facts: relevantFacts,
              digests,
              contentHits,
              history,
              newUserText: row.text,
            });
            h.setMeta({
              blockCount: m.length,
              skillCount: attachedSkills.length,
            });
            return m;
          },
        );

        const client = new OpenRouter({
          apiKey,
          httpReferer: 'https://mantle.crossworks.network',
          appTitle: 'Mantle',
        });

        console.log(
          `[agent] → ${row.fromName ?? 'unknown'} via ${agent.model} (${row.text.length}c, ${history.length} turns, ${digests.length} digests, ${relevantFacts.length} facts, ${contentHits.length} content)`,
        );

        // Resolve the agent's tool allowlist, unioned with every attached
        // skill's tool_slugs. Empty result → tool-loop sends no `tools`
        // and behaves identically to the old single-call path.
        const allowedToolSlugs = effectiveToolSlugs(
          agent.toolSlugs ?? [],
          attachedSkills,
        );
        const allowedTools = await resolveAgentTools(USER_ID!, allowedToolSlugs);

        const loopOutcome = await runToolLoop({
          client,
          model: agent.model,
          params: (agent.params ?? {}) as Record<string, never>,
          ownerId: USER_ID!,
          agentId: agent.id,
          agentSlug: agent.slug,
          agentDepth: 1,
          delegateTo:
            (agent.memoryConfig as { delegate_to?: string[] } | null)?.delegate_to ?? [],
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

        const account = await accountForChat(row.telegramChatId);
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
        const ttsWorker = replyAsVoice
          ? await getDefaultWorker(USER_ID!, 'tts')
          : null;

        const telegramMessageIds = await step(
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
                  { replyTo: row.telegramMessageId },
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
              replyTo: row.telegramMessageId,
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

        await step({ name: 'persist_outbound', kind: 'db_write' }, async (h) => {
          const now = new Date();
          const titleStem = reply.slice(0, 120);
          for (const tgMsgId of telegramMessageIds) {
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
                },
                tags: ['telegram', 'outbound'],
              })
              .returning({ id: nodes.id });
            if (!node) throw new Error('failed to create outbound node');

            await db.insert(telegramMessages).values({
              nodeId: node.id,
              accountId: row.accountId,
              chatId: row.chatPk,
              telegramMessageId: String(tgMsgId),
              text: reply,
              sentAt: now,
              direction: 'outbound',
              agentId: agent.id,
              modelUsed: agent.model,
              replyToId: row.id,
              processed: true,
              processedAt: now,
            });
          }
          h.setMeta({ rows: telegramMessageIds.length });
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

        console.log(`[agent] ✓ replied (${reply.length}c)`);
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[agent] handle failed:', msg);
  } finally {
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
 * Boot-time recovery for the extractor debounce. Debounced work lives
 * in an in-memory Set; a crash inside the 2-second window loses any
 * pending node ids. This catches the case by scanning for recently-
 * inserted nodes of an extractable type that have no summary yet, and
 * queueing them through the same `scheduleExtract` pipeline as if a
 * fresh `pg_notify('node_ingested')` had arrived.
 *
 * Scoped to the last 24h so we don't re-extract years of history if
 * someone bumps the agent for the first time on an old DB. The
 * extractor's own per-agent / per-type guards take it from there.
 */
async function drainUnextractedNodes(): Promise<void> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, USER_ID!),
        ne(nodes.type, 'branch'),
        gte(nodes.createdAt, since),
        isNull(nodes.embedding),
      ),
    )
    .orderBy(asc(nodes.createdAt))
    .limit(500);
  if (rows.length === 0) {
    console.log('[agent] drain extractor: queue empty');
    return;
  }
  console.log(`[agent] drain extractor: queueing ${rows.length} unextracted node(s) from last 24h`);
  for (const r of rows) scheduleExtract(r.id);
}

/** Debounce window for summarize_due — collapses a burst of inserts in the
 *  same chat (e.g. user message + agent reply within the same second) into
 *  one summarization check. The check itself is cheap (one indexed COUNT). */
const SUMMARIZE_DEBOUNCE_MS = 2000;
const summarizePending = new Set<string>();
let summarizeTimer: NodeJS.Timeout | null = null;

function scheduleSummarize(chatPk: string): void {
  summarizePending.add(chatPk);
  if (summarizeTimer) return;
  summarizeTimer = setTimeout(() => {
    summarizeTimer = null;
    const batch = [...summarizePending];
    summarizePending.clear();
    for (const id of batch) {
      summarizeChat(id, USER_ID!).catch((err) =>
        console.error('[agent] summarize error:', err instanceof Error ? err.message : err),
      );
    }
  }, SUMMARIZE_DEBOUNCE_MS);
}

/** Debounce window for node_ingested. Same per-node coalescing logic as
 *  summarize_due — multiple inserts of the same node id within 2s collapse
 *  to one extractor call. Cross-node parallelism preserved (Set iteration). */
const EXTRACT_DEBOUNCE_MS = 2000;
const extractPending = new Set<string>();
let extractTimer: NodeJS.Timeout | null = null;

function scheduleExtract(nodeId: string): void {
  extractPending.add(nodeId);
  if (extractTimer) return;
  extractTimer = setTimeout(() => {
    extractTimer = null;
    const batch = [...extractPending];
    extractPending.clear();
    for (const id of batch) {
      extractNode(id, USER_ID!).catch((err) =>
        console.error('[agent] extract error:', err instanceof Error ? err.message : err),
      );
    }
  }, EXTRACT_DEBOUNCE_MS);
}

async function main() {
  const pg = postgres(DATABASE_URL!, { max: 2 });
  console.log('[agent] starting — config from agents table');

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

  await pg.listen('telegram_message_inserted', (payload: string) => {
    if (!payload) return;
    handleMessage(payload).catch((err) =>
      console.error('[agent] handle error:', err instanceof Error ? err.message : err),
    );
  });
  console.log('[agent] LISTENing on telegram_message_inserted');

  await pg.listen('summarize_due', (payload: string) => {
    if (!payload) return;
    scheduleSummarize(payload);
  });
  console.log('[agent] LISTENing on summarize_due');

  await pg.listen('node_ingested', (payload: string) => {
    if (!payload) return;
    scheduleExtract(payload);
  });
  console.log('[agent] LISTENing on node_ingested');

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

  await drainPending();
  await drainUnextractedNodes();

  await new Promise<never>(() => {});
}

main().catch((err) => {
  console.error('[agent] fatal:', err);
  process.exit(1);
});
