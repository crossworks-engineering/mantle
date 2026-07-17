/**
 * Deepgram STT adapter.
 *
 * Endpoint: POST https://api.deepgram.com/v1/listen?<query-params>
 *
 * Two things that surprised me when wiring this:
 *   1. Auth is `Authorization: Token <key>` — NOT Bearer. Sending
 *      Bearer returns a confusing 401 that doesn't mention the scheme.
 *   2. The body is the raw audio bytes — not multipart. The codec is
 *      conveyed via the request's Content-Type header (e.g.
 *      `audio/webm`), and the model/language/feature flags are URL
 *      query params, not form fields.
 *
 * Query params we always send:
 *   - `model=<id>`             — defaults to nova-3 if unspecified
 *   - `smart_format=true`      — adds punctuation/capitalization
 *   - `language=<iso>`         — optional, omit for auto-detect
 *   - `detect_language=true`   — only when `language` is absent
 *
 * Response (`punctuate=true smart_format=true`):
 *   {
 *     metadata: { duration: 5.4, ... },
 *     results: {
 *       channels: [{
 *         alternatives: [{ transcript, confidence, words: [...] }],
 *         detected_language: 'en'
 *       }]
 *     }
 *   }
 *
 * Deepgram's free tier returns 401 with a clear "exceeded balance"
 * message when credits are spent — we surface that verbatim.
 */

import type { SttDispatcher } from './types';
import type { TranscribeOptions, TranscribeResult } from '../types';
import { DEEPGRAM_BASE_URL } from '../catalogs/deepgram';

const DEFAULT_MODEL = 'nova-3';

type DeepgramResponse = {
  metadata?: { duration?: number };
  results?: {
    channels?: Array<{
      alternatives?: Array<{ transcript?: string; confidence?: number }>;
      detected_language?: string;
    }>;
  };
};

export const deepgramSttAdapter: SttDispatcher = {
  providerId: 'deepgram',
  adapterName: 'deepgram-stt',
  async transcribe(audio: Buffer, opts: TranscribeOptions): Promise<TranscribeResult> {
    if (!opts.apiKey) throw new Error('deepgram-stt: apiKey required');
    if (!audio || audio.length === 0) {
      throw new Error('deepgram-stt: empty audio buffer');
    }

    const model = opts.model || DEFAULT_MODEL;
    const params = new URLSearchParams();
    params.set('model', model);
    params.set('smart_format', 'true');
    if (opts.language) {
      params.set('language', opts.language);
    } else {
      // detect_language has to be explicit — Deepgram's default is
      // English without it, which surprises Afrikaans/Dutch callers.
      params.set('detect_language', 'true');
    }

    const res = await fetch(`${DEEPGRAM_BASE_URL}/v1/listen?${params.toString()}`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${opts.apiKey}`,
        // Mime carries the codec — Deepgram sniffs containers but the
        // explicit header avoids ambiguous-format 400s on opus-in-webm.
        'Content-Type': opts.mimeType || 'application/octet-stream',
      },
      // Buffer is a Uint8Array; Node 18+ fetch accepts it directly.
      body: new Uint8Array(audio),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`deepgram-stt ${res.status}: ${body.slice(0, 400)}`);
    }
    const parsed = (await res.json()) as DeepgramResponse;
    const channel = parsed.results?.channels?.[0];
    const transcript = channel?.alternatives?.[0]?.transcript ?? '';
    const detected = channel?.detected_language ?? null;
    const duration = parsed.metadata?.duration ?? null;

    const cap = opts.maxDurationSeconds ?? 180;
    if (cap > 0 && duration != null && duration > cap) {
      // Same as Whisper — we've already paid, but warn so the caller
      // can refuse to proceed (e.g. polite "too long, please text" reply).
      throw new Error(`deepgram-stt: clip too long: ${duration.toFixed(1)}s exceeds ${cap}s cap`);
    }
    return {
      text: transcript.trim(),
      language: detected ?? opts.language ?? null,
      durationSeconds: typeof duration === 'number' ? duration : null,
      model,
    };
  },
};
