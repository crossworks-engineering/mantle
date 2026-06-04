/**
 * OpenRouter text-to-speech adapter.
 *
 * OpenRouter exposes an OpenAI-compatible speech endpoint
 * (`POST /api/v1/audio/speech`) that routes to OpenAI / Google / Mistral /
 * Microsoft / xAI voices behind one key. Body shape mirrors OpenAI's
 * (`{model, input, voice, response_format, speed}`) and the response is a raw
 * audio byte stream.
 *
 * Model + voice discovery is live + keyless via the Models API filtered to
 * speech output (`/api/v1/models?output_modalities=speech`), which also carries
 * each model's `supported_voices` — so the worker form shows the real model
 * list and the right voices per model (OpenAI's alloy/nova…, xAI's, Azure's
 * `en-US-Harper:MAI-Voice-2`, etc.).
 *
 * One wire note: OpenRouter's speech endpoint emits **mp3 or pcm only**, so we
 * clamp the requested format to mp3 when it's anything other than pcm. And
 * because voices vary by route, the configured voice is passed through verbatim
 * (NOT restricted to OpenAI's named set).
 *
 * Docs: https://openrouter.ai/docs/guides/overview/multimodal/tts
 */

import type { TtsDispatcher } from './types';
import type { SynthesizeOptions, SynthesizeResult, TtsVoice } from '../types';
import { TTS_VOICES } from '../types';
import { mimeForFormat } from '../synthesize';
import type { TtsModelInfo } from '../catalog';
import type { DiscoveryResult } from '../discover';
import { OPENROUTER_BASE_URL } from '../catalogs/openrouter';

/** Default OpenRouter TTS route — xAI Grok voice (voices ara/rex…). OpenRouter
 *  does not proxy OpenAI TTS, so we default to a real speech route on it. */
export const OPENROUTER_TTS_DEFAULT_MODEL = 'x-ai/grok-voice-tts-1.0';
const DEFAULT_VOICE = 'ara';
const MAX_TEXT_CHARS = 4000;
const SPEECH_MODELS_URL = `${OPENROUTER_BASE_URL}/models?output_modalities=speech`;

/**
 * OpenRouter lists many "speech output" models, but its OpenAI-compatible
 * `/audio/speech` endpoint is only fully implemented for a subset. Most of the
 * others are chat-style audio models meant to be driven via /chat/completions
 * with an audio output modality (different params, model-specific voice formats),
 * so calling /audio/speech with them returns 400 (e.g. microsoft/mai-voice-2,
 * which doesn't even accept response_format) or 500 (the open models).
 *
 * Rather than offer routes that fail, discovery is filtered to this verified
 * allowlist. Add ids here once confirmed working through /audio/speech (or, if
 * we ever add the chat-modality path, broaden it). If OpenRouter drops every
 * allowlisted id, discovery falls back to the full speech list so the dropdown
 * is never empty.
 */
const WORKING_AUDIO_SPEECH_MODELS = new Set<string>(['x-ai/grok-voice-tts-1.0']);

/** OpenRouter's /audio/speech only emits mp3 or pcm. Map anything else → mp3. */
function clampFormat(format: string | undefined): 'mp3' | 'pcm' {
  return format === 'pcm' ? 'pcm' : 'mp3';
}

type OrSpeechModel = {
  id?: string;
  name?: string;
  description?: string;
  supported_voices?: string[];
};

/** Keyless fetch of the speech-capable models (id, name, supported_voices). */
async function fetchSpeechModels(): Promise<OrSpeechModel[]> {
  const res = await fetch(SPEECH_MODELS_URL, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`openrouter /models?output_modalities=speech: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: OrSpeechModel[] };
  return (body.data ?? []).filter((m) => typeof m.id === 'string' && m.id.length > 0);
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

    // Voices vary by route (OpenAI / xAI / Azure / Google), so pass the
    // configured voice through verbatim rather than clamping to OpenAI's set.
    const voice =
      typeof opts.voice === 'string' && opts.voice.trim() ? opts.voice.trim() : DEFAULT_VOICE;
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
    return { bytes: buffer, mimeType: mimeForFormat(format), voice: voice as TtsVoice, model };
  },

  async discoverModels(_apiKey: string): Promise<DiscoveryResult<TtsModelInfo>> {
    try {
      const all = await fetchSpeechModels();
      // Only surface routes that actually work via /audio/speech (see allowlist
      // note above). Fall back to the full list if none match, so the dropdown
      // is never empty if OpenRouter re-ids the working model.
      const filtered = all.filter((m) => WORKING_AUDIO_SPEECH_MODELS.has(m.id ?? ''));
      const models = filtered.length > 0 ? filtered : all;
      const available: TtsModelInfo[] = models.map((m) => ({
        id: m.id!,
        label: m.name ?? m.id!,
        description: m.description ?? '',
        voices: Array.isArray(m.supported_voices) ? m.supported_voices : [],
        supportsInstructions: (m.id ?? '').includes('gpt-4o-mini-tts'),
        tier: 'high-quality',
      }));
      return { available, filtered: true, error: null };
    } catch (err) {
      return {
        available: [],
        filtered: false,
        error: err instanceof Error ? err.message : 'discovery failed',
      };
    }
  },

  async voicesForModel(modelId: string) {
    try {
      const models = await fetchSpeechModels();
      const found = models.find((m) => m.id === modelId);
      const voices = found?.supported_voices ?? [];
      if (voices.length > 0) return voices.map((id) => ({ id, description: '' }));
    } catch {
      /* fall through to the static OpenAI set */
    }
    // Fallback — the OpenAI voice set (correct for openai/* routes; a sensible
    // default otherwise). The form still accepts a free-text voice.
    return TTS_VOICES.map((id) => ({ id, description: '' }));
  },

  supportedAudioTags() {
    return [];
  },
  supportedWrappingTags() {
    return [];
  },
};
