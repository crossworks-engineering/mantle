/**
 * ElevenLabs TTS adapter.
 *
 * Wraps ElevenLabs's text-to-speech endpoint behind our unified
 * `TtsDispatcher` interface. The shape differs from OpenAI in a few
 * ways the adapter handles:
 *
 *   - Voice id lives in the URL: POST /v1/text-to-speech/{voice_id}
 *   - Model id is in the request body (`model_id`)
 *   - Output format is a QUERY param (`output_format=opus_48000_64`)
 *   - Auth header is `xi-api-key`, NOT Authorization Bearer
 *   - Voice settings (stability, similarity_boost, style, speed) live
 *     in a `voice_settings` sub-object in the body
 *
 * ElevenLabs's voice ecosystem is its real value over OpenAI TTS:
 * hundreds of premade voices plus user clones. Discovery via
 * GET /v1/voices returns the full list — including clones — so the
 * UI dropdown reflects what the user actually has access to. This is
 * a meaningful upgrade over OpenAI where voices are hardcoded.
 *
 * Mapping OpenAI's named voices (nova, shimmer, etc.) → ElevenLabs:
 * the TtsDispatcher's `voice` option is a string we pass straight
 * through as the voice_id. Operators configure their preferred
 * ElevenLabs voice_id (a UUID-like string) on the worker; we don't
 * try to translate 'nova' → an ElevenLabs equivalent because the
 * names mean different things across providers.
 */

import type { SynthesizeOptions, SynthesizeResult } from '../types';
import type { ChatModelInfo, TtsDispatcher } from './types';
import type { DiscoveryResult } from '../discover';
import type { TtsModelInfo } from '../catalog';
import {
  ELEVENLABS_BASE_URL,
  ELEVENLABS_PREMADE_VOICES,
  ELEVENLABS_TTS_MODELS,
  audioTagsForElevenLabsModel,
  mimeForElevenLabsFormat,
} from '../catalogs/elevenlabs';
import { stripAudioTags } from '../audio-tags';

type ElevenLabsVoicesResponse = {
  voices?: Array<{
    voice_id: string;
    name?: string;
    category?: string; // 'premade' | 'cloned' | 'generated'
    labels?: Record<string, string>;
    description?: string;
  }>;
};

type ElevenLabsModelsResponse = Array<{
  model_id: string;
  name?: string;
  description?: string;
  languages?: Array<{ language_id: string; name: string }>;
  can_do_text_to_speech?: boolean;
}>;

/**
 * Map our `format` option (mp3/opus/etc.) to ElevenLabs's
 * `output_format` query value. We pick conservative defaults — 48kHz
 * Opus 64 kbps for Telegram, 44.1kHz MP3 128 for browser playback.
 */
function elevenLabsFormatFor(format: string | undefined): string {
  switch (format) {
    case 'opus':
      return 'opus_48000_64';
    case 'mp3':
      return 'mp3_44100_128';
    case 'wav':
      return 'wav_44100';
    case 'pcm':
      return 'pcm_44100';
    default:
      return 'opus_48000_64';
  }
}

async function elevenLabsSynthesize(opts: SynthesizeOptions): Promise<SynthesizeResult> {
  if (!opts.apiKey) throw new Error('elevenlabs-tts: apiKey required');
  let text = (opts.text ?? '').trim();
  if (!text) throw new Error('elevenlabs-tts: empty text');
  // Models other than v3 render bracketed tags as literal text
  // (`[laughs]` becomes the spoken phrase "open bracket laughs close
  // bracket"). If the worker picked one of those AND Saskia included
  // tags anyway, strip them before send so the user doesn't hear the
  // brackets.
  const modelId = opts.model || 'eleven_v3';
  const honoursTags = audioTagsForElevenLabsModel(modelId).length > 0;
  if (!honoursTags) {
    text = stripAudioTags(text).text;
  }
  // ElevenLabs requires a voice id (URL path). The OpenAI-shaped
  // `voice` field carries the ElevenLabs voice_id when the worker
  // is configured for this provider. If none is given, fall back to
  // the first premade ('Rachel').
  const voiceId =
    typeof opts.voice === 'string' && opts.voice.length > 0
      ? opts.voice
      : ELEVENLABS_PREMADE_VOICES[0]!.id;
  const outputFormat = elevenLabsFormatFor(opts.format);

  const body: Record<string, unknown> = {
    text,
    model_id: modelId,
    // voice_settings is where ElevenLabs hides the knobs that matter
    // for character: stability + similarity_boost + style + speed.
    // We only forward what's in the unified options; speed maps
    // directly. Stability/style/etc. can be added via opts.instructions
    // later if we want to expose them.
    voice_settings: {
      ...(typeof opts.speed === 'number' ? { speed: opts.speed } : {}),
    },
  };

  const url = new URL(`${ELEVENLABS_BASE_URL}/v1/text-to-speech/${voiceId}`);
  url.searchParams.set('output_format', outputFormat);

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'xi-api-key': opts.apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`elevenlabs tts ${res.status}: ${errBody.slice(0, 400)}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) {
    throw new Error('elevenlabs tts: empty response body');
  }
  return {
    bytes,
    mimeType: mimeForElevenLabsFormat(outputFormat),
    // We hand back the voice id we used so callers can persist it.
    // The TtsResult.voice field is typed as our TtsVoice union (which
    // is OpenAI-shaped); cast through unknown since ElevenLabs ids
    // don't fit that union. Callers reading this value should treat
    // it as a free-form string.
    voice: voiceId as unknown as SynthesizeResult['voice'],
    model: modelId,
  };
}

/**
 * Discover ElevenLabs voices. Returns BOTH premade and user-cloned
 * voices since the user explicitly wants their clones in the picker.
 * Falls back to the static premade list on failure.
 */
async function elevenLabsVoicesForModel(
  _modelId: string,
  apiKey?: string,
): Promise<Array<{ id: string; description: string }>> {
  if (!apiKey) {
    return ELEVENLABS_PREMADE_VOICES.map((v) => ({ id: v.id, description: v.description }));
  }
  try {
    const res = await fetch(`${ELEVENLABS_BASE_URL}/v1/voices`, {
      headers: { 'xi-api-key': apiKey },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return ELEVENLABS_PREMADE_VOICES.map((v) => ({
        id: v.id,
        description: v.description,
      }));
    }
    const parsed = (await res.json()) as ElevenLabsVoicesResponse;
    return (parsed.voices ?? []).map((v) => {
      // Build a useful description: name + category, plus any labels
      // (accent/gender/age) the user has tagged the voice with.
      const labels = v.labels
        ? Object.values(v.labels)
            .filter((s) => typeof s === 'string')
            .join(', ')
        : '';
      const desc = [v.name, v.category, labels].filter(Boolean).join(' · ');
      return { id: v.voice_id, description: desc || v.voice_id };
    });
  } catch {
    return ELEVENLABS_PREMADE_VOICES.map((v) => ({
      id: v.id,
      description: v.description,
    }));
  }
}

/**
 * Discover available TTS models. ElevenLabs's /v1/models returns the
 * full model catalogue including any beta access the key has.
 */
async function elevenLabsDiscoverModels(apiKey: string): Promise<DiscoveryResult<TtsModelInfo>> {
  try {
    const res = await fetch(`${ELEVENLABS_BASE_URL}/v1/models`, {
      headers: { 'xi-api-key': apiKey },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        available: ELEVENLABS_TTS_MODELS.map(toTtsModelInfo),
        filtered: false,
        error: `elevenlabs /v1/models ${res.status}: ${body.slice(0, 200)}`,
      };
    }
    const parsed = (await res.json()) as ElevenLabsModelsResponse;
    const liveIds = new Set(
      parsed.filter((m) => m.can_do_text_to_speech !== false).map((m) => m.model_id),
    );
    const available = ELEVENLABS_TTS_MODELS.filter((m) => liveIds.has(m.id)).map(toTtsModelInfo);
    return {
      available: available.length > 0 ? available : ELEVENLABS_TTS_MODELS.map(toTtsModelInfo),
      filtered: available.length > 0,
      error: null,
    };
  } catch (err) {
    return {
      available: ELEVENLABS_TTS_MODELS.map(toTtsModelInfo),
      filtered: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Bridge from our ElevenLabs-shaped model entry to the generic
 *  TtsModelInfo the catalog/UI consume. */
function toTtsModelInfo(m: { id: string; label: string; description: string }): TtsModelInfo {
  return {
    id: m.id,
    label: m.label,
    description: m.description,
    // ElevenLabs doesn't slice voices per-model the way OpenAI does
    // (voice library applies across all models), so we don't fix a
    // voice list here. `voicesForModel` queries live instead.
    voices: [],
    supportsInstructions: false,
    tier: 'high-quality',
  };
}

// Silence unused-type warning when ChatModelInfo isn't used directly
// in this file (it's imported via the dispatcher contract).
void ([] as ChatModelInfo[]);

export const elevenLabsTtsAdapter: TtsDispatcher = {
  providerId: 'elevenlabs',
  adapterName: 'elevenlabs-tts',
  synthesize: elevenLabsSynthesize,
  discoverModels: elevenLabsDiscoverModels,
  voicesForModel: elevenLabsVoicesForModel,
  supportedAudioTags(modelId) {
    return audioTagsForElevenLabsModel(modelId);
  },
  supportedWrappingTags() {
    // Audited: ElevenLabs v3 expresses everything through inline
    // [bracket] audio tags — there's no angle-bracket wrapping
    // vocabulary to advertise.
    return [];
  },
};
