/**
 * Telegram turn, voice side: transcribing an inbound voice note before
 * anything downstream reads `row.text`, and the audio-tag prompt suffix that
 * tells the responder which speech cues its TTS worker honours. Split out of
 * runtime.ts on 2026-09-02 (audit, bloat B2).
 */
import { and, eq } from 'drizzle-orm';
import {
  db,
  telegramMessages,
  bumpWorkerUsage as bumpAiWorkerUsage,
  getDefaultWorker,
  getAgentTtsWorker,
  type Agent,
  type SttParams,
} from '@mantle/db';
import { accountById, downloadTelegramFile } from '@mantle/telegram';
import { getApiKey, getApiKeyById } from '@mantle/api-keys';
import { composeAudioTagInstructions, getSttAdapter, getTtsAdapter } from '@mantle/voice';
import { step } from '@mantle/tracing';
import { errorMessage } from '@mantle/std';
import type { InboundRow } from './types';

/**
 * Transcribe the voice note behind `voiceFileId`, then replace the placeholder
 * text on the in-memory row AND the DB row so the rest of the pipeline
 * (load_context, history, embeddings, extractor) sees real words. Returns
 * false when transcription failed or came back empty; the sequencer then
 * apologises in text rather than crashing the trace.
 */
export async function transcribeInboundVoice(args: {
  ownerId: string;
  row: InboundRow;
  voiceFileId: string;
}): Promise<boolean> {
  const { ownerId, row, voiceFileId } = args;
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
      const sttWorker = await getDefaultWorker(ownerId, 'stt');
      let apiKey: string | null;
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
        apiKey = await getApiKey(ownerId, 'openai');
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
      const downloaded = await downloadTelegramFile(account, voiceFileId);
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
    console.error('[agent] voice transcription failed:', errorMessage(err));
    return null;
  });

  if (!transcript || !transcript.text) return false;

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
    .where(and(eq(telegramMessages.id, row.id)));
  return true;
}

/**
 * Tell the responder which speech tags its configured TTS will honour:
 * inline cues (ElevenLabs v3 [laughs]/[sighs]; OpenAI none) AND wrapping
 * styles (xAI Grok <whisper>…</whisper>/<soft>/<slow>). Looked up once per
 * turn so the prompt stays current if the TTS worker is swapped between
 * turns. Empty when there is no TTS worker, no tags-capable model, or no
 * adapter — the prompt concat is then a no-op. Best-effort decoration: a DB
 * blip here never kills the turn.
 */
export async function audioTagInstructionsFor(ownerId: string, agent: Agent): Promise<string> {
  try {
    const ttsWorkerForTags = await getAgentTtsWorker(ownerId, agent.ttsWorkerId);
    if (!ttsWorkerForTags) return '';
    const ttsAdapterForTags = getTtsAdapter(ttsWorkerForTags.provider);
    const tags = ttsAdapterForTags?.supportedAudioTags?.(ttsWorkerForTags.model) ?? [];
    const wrappingTags = ttsAdapterForTags?.supportedWrappingTags?.(ttsWorkerForTags.model) ?? [];
    return composeAudioTagInstructions(tags, wrappingTags);
  } catch (err) {
    console.error('[agent] audio-tag prompt injection skipped:', errorMessage(err));
    return '';
  }
}
