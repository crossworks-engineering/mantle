/**
 * OpenRouter speech-to-text adapter.
 *
 * Endpoint: POST https://openrouter.ai/api/v1/audio/transcriptions — JSON
 * (NOT multipart, unlike OpenAI Whisper). Audio is passed base64-encoded
 * inside `input_audio`, and the response is `{ text, usage }`. Routes to
 * OpenAI Whisper / GPT-4o Transcribe / Google Chirp / Groq behind one key.
 *
 * Docs: https://openrouter.ai/docs/api/api-reference/transcriptions/create-audio-transcriptions
 */

import type { SttDispatcher } from './types';
import type { TranscribeOptions, TranscribeResult } from '../types';
import { OPENROUTER_BASE_URL } from '../catalogs/openrouter';

/** Default OpenRouter STT route — OpenAI Whisper large v3. */
export const OPENROUTER_STT_DEFAULT_MODEL = 'openai/whisper-large-v3';

/** Map an audio MIME type to the bare container hint OpenRouter expects in
 *  `input_audio.format` (wav/mp3/flac/m4a/ogg/webm/aac). Falls back to the
 *  MIME subtype, then 'ogg' (Telegram voice notes are OGG/Opus). */
function formatFromMime(mimeType: string | undefined): string {
  const sub = (mimeType ?? '').split('/')[1]?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (sub === 'mpeg' || sub === 'mp3') return 'mp3';
  if (sub === 'x-m4a' || sub === 'mp4' || sub === 'm4a') return 'm4a';
  if (sub === 'wav' || sub === 'x-wav') return 'wav';
  if (sub === 'webm') return 'webm';
  if (sub === 'flac') return 'flac';
  if (sub === 'aac') return 'aac';
  if (sub === 'ogg' || sub === 'opus') return 'ogg';
  return sub || 'ogg';
}

export const openrouterSttAdapter: SttDispatcher = {
  providerId: 'openrouter',
  adapterName: 'openrouter-stt',
  async transcribe(audio: Buffer, opts: TranscribeOptions): Promise<TranscribeResult> {
    if (!opts.apiKey) throw new Error('openrouter-stt: apiKey required');
    if (!audio || audio.length === 0) throw new Error('openrouter-stt: empty audio buffer');

    const model = opts.model || OPENROUTER_STT_DEFAULT_MODEL;
    const res = await fetch(`${OPENROUTER_BASE_URL}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'content-type': 'application/json',
        'HTTP-Referer': 'https://mantle.crossworks.network',
        'X-Title': 'Mantle',
      },
      body: JSON.stringify({
        model,
        input_audio: {
          data: audio.toString('base64'),
          format: formatFromMime(opts.mimeType),
        },
        ...(opts.language ? { language: opts.language } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`openrouter-stt ${res.status}: ${body.slice(0, 400)}`);
    }
    const parsed = (await res.json()) as { text?: string };
    return {
      text: (parsed.text ?? '').trim(),
      // The endpoint returns text + usage but not detected language / duration.
      language: opts.language ?? null,
      durationSeconds: null,
      model,
    };
  },
};
