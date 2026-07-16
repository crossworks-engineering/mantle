/**
 * Google (Gemini) text-to-speech adapter.
 *
 * Endpoint: POST {GOOGLE_BASE_URL}/models/{model}:generateContent
 * Auth:     x-goog-api-key header
 *
 * Gemini TTS uses the SAME generateContent path as chat — the
 * difference is `generationConfig.responseModalities: ['AUDIO']` plus
 * a `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName` field.
 * The audio comes back inline as a base64 PCM payload in
 * `candidates[0].content.parts[0].inlineData`. Native sample rate is
 * 24kHz mono.
 *
 * Format mapping: Gemini returns raw PCM. We always pass it through
 * as-is; the caller's `format` request is a hint that doesn't change
 * what comes off the wire. If you want OGG/Opus for Telegram, use
 * OpenAI or ElevenLabs — encoding PCM→Opus would require ffmpeg in
 * the runtime, which we deliberately don't ship.
 *
 * Style steering: Gemini honours inline audio tags ([laughs],
 * [whispers]) AND natural-language prompts inside the text ("Say
 * excitedly: ..."). We expose tags via the adapter framework; the
 * NL-steering path stays available via the worker's system_prompt.
 */

import type { SynthesizeOptions, SynthesizeResult } from '../types';
import type { TtsDispatcher } from './types';
import type { TtsModelInfo } from '../catalog';
import type { DiscoveryResult } from '../discover';
import {
  GOOGLE_AUDIO_TAGS,
  GOOGLE_BASE_URL,
  GOOGLE_TTS_MODELS,
  GOOGLE_TTS_VOICES,
  audioTagsForGoogleTtsModel,
} from '../catalogs/google';

type GeminiTtsResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        inlineData?: {
          mimeType?: string;
          data?: string; // base64
        };
      }>;
    };
  }>;
  modelVersion?: string;
};

async function googleTtsSynthesize(opts: SynthesizeOptions): Promise<SynthesizeResult> {
  if (!opts.apiKey) throw new Error('google-tts: apiKey required');
  const text = (opts.text ?? '').trim();
  if (!text) throw new Error('google-tts: empty text');

  // Default to the cheaper flash model; consumers override via the
  // worker's `model` column.
  const modelId = opts.model || 'gemini-2.5-flash-preview-tts';
  const voiceName = typeof opts.voice === 'string' && opts.voice.length > 0 ? opts.voice : 'Kore';

  const body: Record<string, unknown> = {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName },
        },
      },
    },
  };

  const res = await fetch(`${GOOGLE_BASE_URL}/models/${modelId}:generateContent`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': opts.apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`google tts ${res.status}: ${errBody.slice(0, 400)}`);
  }
  const parsed = (await res.json()) as GeminiTtsResponse;
  // The audio rides inline in the parts array as base64. We take the
  // first inlineData block we find; Gemini only returns one for TTS.
  const inlineData = parsed.candidates?.[0]?.content?.parts?.find(
    (p) => p.inlineData?.data,
  )?.inlineData;
  if (!inlineData?.data) {
    throw new Error('google tts: no audio data in response');
  }
  const bytes = Buffer.from(inlineData.data, 'base64');
  // Gemini returns PCM (audio/pcm or audio/L16 depending on the
  // model version) — the mimeType comes back on the inlineData
  // payload. Default to audio/pcm if missing so downstream knows.
  const mime = inlineData.mimeType ?? 'audio/pcm';

  return {
    bytes,
    mimeType: mime,
    voice: voiceName as unknown as SynthesizeResult['voice'],
    model: parsed.modelVersion ?? modelId,
  };
}

/** Discovery: filter the live /v1beta/models response to TTS models
 *  the key can use. Gemini lists all models in one endpoint regardless
 *  of capability; we filter by id pattern and supportedGenerationMethods. */
async function googleTtsDiscover(apiKey: string): Promise<DiscoveryResult<TtsModelInfo>> {
  try {
    const res = await fetch(`${GOOGLE_BASE_URL}/models`, {
      headers: { 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return {
        available: ttsModelInfo(),
        filtered: false,
        error: `google /v1beta/models ${res.status}`,
      };
    }
    type Resp = {
      models?: Array<{ name: string; supportedGenerationMethods?: string[] }>;
    };
    const parsed = (await res.json()) as Resp;
    const ids = new Set(
      (parsed.models ?? [])
        .filter(
          (m) =>
            // TTS models always have 'generateContent' in their supported
            // methods (since the audio path uses the same endpoint).
            // We filter by name suffix '-tts' to scope.
            m.name.endsWith('-tts') &&
            (m.supportedGenerationMethods ?? []).includes('generateContent'),
        )
        .map((m) => m.name.replace(/^models\//, '')),
    );
    const available = ttsModelInfo().filter((m) => ids.has(m.id));
    return {
      available: available.length > 0 ? available : ttsModelInfo(),
      filtered: available.length > 0,
      error: null,
    };
  } catch (err) {
    return {
      available: ttsModelInfo(),
      filtered: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function ttsModelInfo(): TtsModelInfo[] {
  return [
    {
      id: 'gemini-2.5-flash-preview-tts',
      label: 'Gemini 2.5 Flash TTS',
      description:
        '30 voices, low-latency, cost-efficient. Best for real-time assistants and high-volume narration. Audio tags + natural-language steering both supported.',
      voices: GOOGLE_TTS_VOICES.map((v) => v.id),
      supportsInstructions: false,
      tier: 'low-latency',
    },
    {
      id: 'gemini-2.5-pro-preview-tts',
      label: 'Gemini 2.5 Pro TTS',
      description:
        'Studio-quality speech. Best for long-form narration and creative workflows requiring vocal clarity.',
      voices: GOOGLE_TTS_VOICES.map((v) => v.id),
      supportsInstructions: false,
      tier: 'high-quality',
    },
  ];
}

async function googleTtsVoicesForModel(
  _modelId: string,
): Promise<Array<{ id: string; description: string }>> {
  // Both Flash and Pro share the same 30-voice set. Caller could
  // pass apiKey here if Gemini ever exposes per-voice listing; for
  // now the static set covers all current models.
  return GOOGLE_TTS_VOICES.map((v) => ({ id: v.id, description: v.description }));
}

void GOOGLE_TTS_MODELS; // referenced indirectly via the helpers
void GOOGLE_AUDIO_TAGS;

export const googleTtsAdapter: TtsDispatcher = {
  providerId: 'google',
  adapterName: 'google-tts',
  synthesize: googleTtsSynthesize,
  discoverModels: googleTtsDiscover,
  voicesForModel: googleTtsVoicesForModel,
  supportedAudioTags(modelId) {
    return audioTagsForGoogleTtsModel(modelId);
  },
  supportedWrappingTags() {
    // Audited: Gemini TTS steers via inline [bracket] tags +
    // natural-language prompts ("say cheerfully: …"), not angle-bracket
    // wrapping tags.
    return [];
  },
};
