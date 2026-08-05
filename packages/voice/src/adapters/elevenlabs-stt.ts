/**
 * ElevenLabs Scribe STT adapter.
 *
 * Endpoint: POST {ELEVENLABS_BASE_URL}/v1/speech-to-text
 * Auth:     `xi-api-key: <key>` header (NOT Bearer — ElevenLabs is
 *           consistent in using their own header name for both TTS
 *           and STT).
 * Body:     multipart/form-data with `model_id` + `file`, optional
 *           `language_code`, `diarize`, `timestamps_granularity`.
 * Response: `{ text, language_code, language_probability, words?: [...] }`
 *
 * Notes:
 *   - The model id is `scribe_v1` today; future models would extend
 *     ELEVENLABS_STT_MODELS in the catalog.
 *   - `language_code` is BCP-47 (e.g. `en`, `af`, `de`). If omitted,
 *     Scribe auto-detects and returns the detected `language_code`
 *     in the body.
 *   - Duration is not returned in the basic response — only when
 *     word-level timestamps are requested. We don't request them by
 *     default (saves a few cents on long clips), so durationSeconds
 *     comes back null. Operators wanting word timing can switch the
 *     worker's params later (not exposed in the UI yet).
 *
 * Discovery: ElevenLabs's `/v1/models` returns TTS models, not STT
 * models, so we don't implement discoverModels here — the form falls
 * back to the single-row static catalog and that's fine.
 */

import type { SttDispatcher } from './types';
import type { TranscribeOptions, TranscribeResult } from '../types';
import { filenameForMime } from '../transcribe';
import { ELEVENLABS_BASE_URL } from '../catalogs/elevenlabs';

const DEFAULT_MODEL = 'scribe_v1';

type ScribeResponse = {
  text?: string;
  language_code?: string;
  language_probability?: number;
};

export const elevenLabsSttAdapter: SttDispatcher = {
  providerId: 'elevenlabs',
  adapterName: 'elevenlabs-stt',
  // Scribe takes language_code and echoes the detected one back.
  supports: ['language'],
  async transcribe(audio: Buffer, opts: TranscribeOptions): Promise<TranscribeResult> {
    if (!opts.apiKey) throw new Error('elevenlabs-stt: apiKey required');
    if (!audio || audio.length === 0) {
      throw new Error('elevenlabs-stt: empty audio buffer');
    }

    const model = opts.model || DEFAULT_MODEL;
    const filename = filenameForMime(opts.mimeType);
    const form = new FormData();
    form.append('model_id', model);
    if (opts.language) form.append('language_code', opts.language);
    const blob = new Blob([new Uint8Array(audio)], { type: opts.mimeType });
    form.append('file', blob, filename);

    const res = await fetch(`${ELEVENLABS_BASE_URL}/v1/speech-to-text`, {
      method: 'POST',
      headers: { 'xi-api-key': opts.apiKey },
      body: form,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`elevenlabs-stt ${res.status}: ${body.slice(0, 400)}`);
    }
    const parsed = (await res.json()) as ScribeResponse;
    return {
      text: (parsed.text ?? '').trim(),
      language: parsed.language_code ?? opts.language ?? null,
      // Word-timestamps not requested → no duration. See header note.
      durationSeconds: null,
      model,
    };
  },
};
