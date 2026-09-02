/**
 * Telegram turn, stage: delivery. Voice in → voice out (or the responder's
 * `[VOICE]` opt-in) drives off the agent's TTS worker; any TTS failure falls
 * through to a text send rather than dropping the reply. Never loses the
 * reply: a send failure is captured so the sequencer persists it undelivered.
 * Split out of runtime.ts on 2026-09-02 (audit, bloat B2).
 */
import {
  bumpWorkerUsage as bumpAiWorkerUsage,
  getAgentTtsWorker,
  type TelegramAccount,
  type TtsParams,
} from '@mantle/db';
import { sendMessage, sendVoice } from '@mantle/telegram';
import { getApiKeyById } from '@mantle/api-keys';
import { getTtsAdapter, stripAudioTags } from '@mantle/voice';
import { stripInlineMediaImages } from '@mantle/content/markdown-refs';
import { step } from '@mantle/tracing';
import { errorMessage } from '@mantle/std';
import type { InboundRow } from './types';

export interface Delivery {
  telegramMessageIds: number[];
  delivered: boolean;
  sendError: string | null;
}

export async function deliverReply(args: {
  ownerId: string;
  account: TelegramAccount;
  row: InboundRow;
  reply: string;
  replyAsVoice: boolean;
  ttsWorker: Awaited<ReturnType<typeof getAgentTtsWorker>> | null;
}): Promise<Delivery> {
  const { account, row, reply, replyAsVoice, ttsWorker } = args;
  // Generate-then-send, but never lose the reply: if the send throws, the
  // send_telegram step still records the error and the sequencer persists
  // the reply (flagged undelivered) so it stays recoverable, then fails the
  // trace so it surfaces in "Needs attention".
  let telegramMessageIds: number[] = [];
  let delivered = false;
  let sendError: string | null = null;
  try {
    telegramMessageIds = await step(
      {
        name: 'send_telegram',
        kind: 'send',
        input: { mode: replyAsVoice ? 'voice' : 'text' },
      },
      async (h) => {
        if (replyAsVoice && ttsWorker?.apiKeyId) {
          // Synthesise inside the same step so cost + meta roll up
          // here. We catch and fall through to text on failure so
          // a transient OpenAI hiccup doesn't drop the reply.
          try {
            const ttsApiKey = await getApiKeyById(ttsWorker.apiKeyId);
            if (!ttsApiKey) {
              throw new Error(`tts worker '${ttsWorker.slug}' api key not found`);
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
            const voiceMessageId = await sendVoice(account, row.telegramChatId, synth.bytes, {
              replyTo: row.telegramMessageId ?? undefined,
            });
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
            console.error('[agent] tts failed, falling back to text:', errorMessage(err));
            h.setMeta({ ttsFallback: true });
            // Fall through to text path below.
          }
        }
        // Strip any audio tags the responder emitted — they only make
        // sense in a voice context. If the reply ends up here
        // (text-out, or TTS fallback after failure), bracketed
        // tags would otherwise appear as literal text.
        const { text: taggedReply, stripped } = stripAudioTags(reply);
        // Inline `![alt](media:<file-id>)` markers place a stored picture
        // in the WEB chat (RichText resolves them). Telegram sends plain
        // text with no parse_mode, so a marker would arrive as literal
        // `![…](media:…)` gibberish. Strip them, leaving any alt text
        // behind. A picture reaches Telegram only via `show_image`'s
        // sendPhoto, which is what the visual_answers skill tells her.
        const { text: textReply, stripped: mediaStripped } = stripInlineMediaImages(taggedReply);
        const ids = await sendMessage(account, row.telegramChatId, textReply, {
          replyTo: row.telegramMessageId ?? undefined,
        });
        h.setMeta({
          mode: 'text',
          chunks: ids.length,
          replyLength: textReply.length,
          ...(stripped > 0 ? { audioTagsStripped: stripped } : {}),
          ...(mediaStripped > 0 ? { inlineImagesStripped: mediaStripped } : {}),
        });
        return ids;
      },
    );
    delivered = true;
  } catch (err) {
    // The send_telegram step already recorded the error; capture it and
    // fall through to persist so the generated reply isn't lost.
    sendError = errorMessage(err);
  }
  return { telegramMessageIds, delivered, sendError };
}
