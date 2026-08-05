/**
 * xAI (Grok) STT adapter.
 *
 * Endpoint: POST https://api.x.ai/v1/stt — multipart/form-data, auth
 * via Bearer token. The xAI docs explicitly call out that `file` must
 * be the LAST field in the multipart body; the server's parser blows
 * up otherwise. We add the file last in this adapter for that reason.
 *
 * Audio formats accepted: WAV, MP3, WebM, OGG, M4A, MP4. Max 500 MB.
 *
 * Differences vs. OpenAI Whisper that matter to us:
 *   - No `model` field in the request — there's currently one model.
 *     We surface 'grok-stt' as the recorded model name for /traces.
 *   - No duration in the response — the server returns just `{ text }`,
 *     so we can't enforce maxDurationSeconds the way Whisper does
 *     (Whisper returns `duration` in verbose_json). The cap is checked
 *     opportunistically: if we ever wire it via header inspection we'd
 *     add it; for now the operator's recording UI clamps length.
 *   - `format: 'true'` is required to get cleaned-up text (paragraph
 *     punctuation, casing). Without it the response is raw lower-case.
 *
 * Discovery: xAI doesn't publish a programmatic STT model list. The
 * adapter omits `discoverModels` so the form falls back to the static
 * one-model catalog.
 *
 * Docs: https://docs.x.ai/developers/model-capabilities/audio/speech-to-text
 */

import type { SttDispatcher } from './types';
import type { TranscribeOptions, TranscribeResult } from '../types';
import { filenameForMime } from '../transcribe';
import { XAI_BASE_URL } from '../catalogs/xai';

export const xaiSttAdapter: SttDispatcher = {
  providerId: 'xai',
  adapterName: 'xai-stt',
  // /v1/stt takes language. Note `format` (punctuation) DEPENDS on it, so we
  // only enable formatting when a language is set.
  supports: ['language'],
  async transcribe(audio: Buffer, opts: TranscribeOptions): Promise<TranscribeResult> {
    if (!opts.apiKey) throw new Error('xai-stt: apiKey required');
    if (!audio || audio.length === 0) {
      throw new Error('xai-stt: empty audio buffer');
    }

    const filename = filenameForMime(opts.mimeType);
    const form = new FormData();
    // Order matters — xAI requires `file` as the LAST field. Build
    // all the metadata fields first, then append the file.
    //
    // `format=true` (punctuation/capitalisation) REQUIRES `language`, per
    // docs.x.ai. It used to be sent unconditionally, so on the common
    // auto-detect path — no language configured, which is the default for a
    // multilingual user — the request carried a flag it could not satisfy.
    if (opts.language) {
      form.append('language', opts.language);
      form.append('format', 'true');
    }
    const blob = new Blob([new Uint8Array(audio)], { type: opts.mimeType });
    form.append('file', blob, filename);

    const res = await fetch(`${XAI_BASE_URL}/stt`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.apiKey}` },
      body: form,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`xai-stt ${res.status}: ${body.slice(0, 400)}`);
    }
    // The response DOES carry the detected language and the duration
    // (`{text, language, duration, words[], channels[]}`). A comment here
    // previously claimed it echoed neither, and both were thrown away —
    // so an auto-detected language never reached /traces and the duration
    // cap below had nothing to check against.
    const parsed = (await res.json()) as {
      text?: string;
      language?: string;
      duration?: number;
    };
    const durationSeconds = typeof parsed.duration === 'number' ? parsed.duration : null;
    const cap = opts.maxDurationSeconds ?? 180;
    if (cap > 0 && durationSeconds != null && durationSeconds > cap) {
      throw new Error(`xai-stt: clip too long: ${durationSeconds.toFixed(1)}s exceeds ${cap}s cap`);
    }
    return {
      text: (parsed.text ?? '').trim(),
      language: parsed.language ?? opts.language ?? null,
      durationSeconds,
      model: opts.model || 'grok-stt',
    };
  },
};
