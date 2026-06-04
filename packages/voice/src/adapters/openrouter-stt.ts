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
import type { SttModelInfo } from '../catalog';
import type { DiscoveryResult } from '../discover';
import { OPENROUTER_BASE_URL } from '../catalogs/openrouter';

/** Default OpenRouter STT route — GPT-4o mini Transcribe (cheap + accurate;
 *  operator-verified on a single OpenRouter key). */
export const OPENROUTER_STT_DEFAULT_MODEL = 'openai/gpt-4o-mini-transcribe';

/** Curated STT routes. OpenRouter's transcription models are reachable only via
 *  the dedicated /audio/transcriptions endpoint — they are NOT listed in
 *  /v1/models (same as embedding models), so there's no live filter to query.
 *  This documented set drives the worker-form dropdown; the field also accepts a
 *  free-text slug for routes added later. */
const OPENROUTER_STT_MODELS: readonly SttModelInfo[] = [
  {
    id: 'openai/gpt-4o-mini-transcribe',
    label: 'GPT-4o mini Transcribe (OpenAI)',
    description: 'Cheap, fast, accurate. The default.',
    supportsLanguageHint: true,
    supportsTimestamps: false,
  },
  {
    id: 'openai/gpt-4o-transcribe',
    label: 'GPT-4o Transcribe (OpenAI)',
    description: 'Higher-accuracy transcription on the GPT-4o stack.',
    supportsLanguageHint: true,
    supportsTimestamps: false,
  },
  {
    id: 'openai/whisper-large-v3',
    label: 'Whisper large v3 (OpenAI)',
    description: 'Robust multilingual Whisper.',
    supportsLanguageHint: true,
    supportsTimestamps: false,
  },
];

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

  async discoverModels(_apiKey: string): Promise<DiscoveryResult<SttModelInfo>> {
    // Curated — OpenRouter STT models aren't enumerable via /v1/models.
    return { available: [...OPENROUTER_STT_MODELS], filtered: true, error: null };
  },
};
