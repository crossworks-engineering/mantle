/**
 * OpenRouter text-to-speech adapter.
 *
 * OpenRouter exposes an OpenAI-compatible speech endpoint
 * (`POST /api/v1/audio/speech`) that routes to OpenAI / Google / Mistral /
 * Microsoft voices behind one key. Body shape is identical to OpenAI's
 * (`{model, input, voice, response_format, speed}`) and the response is a raw
 * audio byte stream — so this mirrors `synthesize.ts`, just pointed at the
 * OpenRouter base URL with `provider/model` slugs.
 *
 * One wire difference: OpenRouter's speech endpoint emits **mp3 or pcm only**
 * (no opus/aac/flac/wav), so we clamp the requested format to mp3 (the safe,
 * widely-playable default) when it's anything other than pcm.
 *
 * Docs: https://openrouter.ai/docs/guides/overview/multimodal/tts
 */

import type { TtsDispatcher } from './types';
import type { SynthesizeOptions, SynthesizeResult, TtsVoice } from '../types';
import { TTS_VOICES } from '../types';
import { mimeForFormat, isTtsVoice } from '../synthesize';
import { OPENROUTER_BASE_URL } from '../catalogs/openrouter';

/** Default OpenRouter TTS route — OpenAI's gpt-4o-mini-tts (the cheapest
 *  broad-voice model). The worker form / provisioner can override. */
export const OPENROUTER_TTS_DEFAULT_MODEL = 'openai/gpt-4o-mini-tts';
const DEFAULT_VOICE: TtsVoice = 'nova';
const MAX_TEXT_CHARS = 4000;

/** OpenRouter's /audio/speech only emits mp3 or pcm. Map anything else → mp3. */
function clampFormat(format: string | undefined): 'mp3' | 'pcm' {
  return format === 'pcm' ? 'pcm' : 'mp3';
}

export const openrouterTtsAdapter: TtsDispatcher = {
  providerId: 'openrouter',
  adapterName: 'openrouter-tts',
  async synthesize(opts: SynthesizeOptions): Promise<SynthesizeResult> {
    if (!opts.apiKey) throw new Error('openrouter-tts: apiKey required');
    const raw = (opts.text ?? '').trim();
    if (!raw) throw new Error('openrouter-tts: empty text');
    const text =
      raw.length > MAX_TEXT_CHARS
        ? raw.slice(0, raw.lastIndexOf(' ', MAX_TEXT_CHARS) || MAX_TEXT_CHARS)
        : raw;

    const voice: TtsVoice = isTtsVoice(opts.voice) ? opts.voice : DEFAULT_VOICE;
    const model = opts.model ?? OPENROUTER_TTS_DEFAULT_MODEL;
    const format = clampFormat(opts.format);
    const speed = Math.min(Math.max(opts.speed ?? 1.0, 0.25), 4.0);

    const res = await fetch(`${OPENROUTER_BASE_URL}/audio/speech`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'content-type': 'application/json',
        'HTTP-Referer': 'https://mantle.crossworks.network',
        'X-Title': 'Mantle',
      },
      body: JSON.stringify({
        model,
        voice,
        input: text,
        response_format: format,
        speed,
        ...(opts.instructions ? { instructions: opts.instructions } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`openrouter-tts ${res.status}: ${body.slice(0, 400)}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0) throw new Error('openrouter-tts: empty response');
    return { bytes: buffer, mimeType: mimeForFormat(format), voice, model };
  },
  async voicesForModel() {
    // OpenRouter TTS voices vary by route; the default gpt-4o-mini-tts route
    // uses the OpenAI voice set. Surface that closed list (the form can still
    // accept a free-text voice for other routes like Azure's MAI voices).
    return TTS_VOICES.map((id) => ({ id, description: '' }));
  },
  supportedAudioTags() {
    return [];
  },
  supportedWrappingTags() {
    return [];
  },
};
