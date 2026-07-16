/**
 * xAI (Grok) text-to-speech adapter.
 *
 * Endpoint: POST {XAI_BASE_URL}/tts
 *   - text:              up to 15,000 chars
 *   - voice_id:          'eve' | 'ara' | 'rex' | 'sal' | 'leo'
 *   - language:          BCP-47 ('en', 'en-US', 'pt-BR', or 'auto')
 *   - output_format:     { codec, sample_rate?, bit_rate? }
 *   - text_normalization, optimize_streaming_latency: optional knobs
 *
 * Auth: Bearer XAI_API_KEY. The same key used for chat works for TTS.
 *
 * Speech tags: inline cues ([laugh], [giggle], [sigh] …) via
 * `supportedAudioTags`, and wrapping styles (<whisper>…</whisper>,
 * <soft>, <slow> …) via `supportedWrappingTags`. Both sets live in
 * catalogs/xai.ts and are injected into Saskia's prompt by the runtime
 * so she only emits tags this model renders.
 *
 * Output format mapping for Telegram-native voice notes: there's no
 * 'opus' codec on Grok TTS — Telegram's sendVoice prefers OGG/Opus.
 * The adapter falls back to MP3 (with audio/mpeg MIME) which
 * Telegram accepts but renders as a generic audio file, NOT a
 * voice-note bubble. Use OpenAI or ElevenLabs for the proper voice-
 * bubble UI until xAI adds Opus output.
 */

import type { SynthesizeOptions, SynthesizeResult } from '../types';
import type { TtsDispatcher } from './types';
import type { TtsModelInfo } from '../catalog';
import type { DiscoveryResult } from '../discover';
import {
  XAI_AUDIO_TAGS,
  XAI_BASE_URL,
  XAI_TTS_MODEL_ID,
  XAI_TTS_VOICES,
  XAI_WRAPPING_TAGS,
  audioTagsForXaiTtsModel,
} from '../catalogs/xai';
import { stripAudioTags } from '../audio-tags';

/** Map our `format` option to xAI's `output_format.codec`. xAI doesn't
 *  offer opus, so opus → mp3 with a hint. Other formats map directly. */
function xaiCodecFor(format: string | undefined): {
  codec: 'mp3' | 'wav' | 'pcm' | 'mulaw' | 'alaw';
  mime: string;
} {
  switch (format) {
    case 'mp3':
      return { codec: 'mp3', mime: 'audio/mpeg' };
    case 'wav':
      return { codec: 'wav', mime: 'audio/wav' };
    case 'pcm':
      return { codec: 'pcm', mime: 'audio/pcm' };
    // 'opus' isn't supported by xAI — fall back to mp3 so the call
    // succeeds. Caller responsible for downstream MIME handling.
    case 'opus':
    default:
      return { codec: 'mp3', mime: 'audio/mpeg' };
  }
}

async function xaiTtsSynthesize(opts: SynthesizeOptions): Promise<SynthesizeResult> {
  if (!opts.apiKey) throw new Error('xai-tts: apiKey required');
  let text = (opts.text ?? '').trim();
  if (!text) throw new Error('xai-tts: empty text');
  // Hard cap from the docs — 15k chars per call. Trim defensively so
  // a very long reply doesn't 400.
  if (text.length > 15_000) text = text.slice(0, 15_000);

  // The model the worker picked. xAI publishes grok-voice-latest as
  // the stable alias; operators may pin a specific revision later.
  const modelId = opts.model || XAI_TTS_MODEL_ID;
  // If the model doesn't honour tags (future variant), strip them so
  // the user doesn't hear bracketed text. Current grok-voice-latest
  // does honour them.
  const honoursTags = audioTagsForXaiTtsModel(modelId).length > 0;
  if (!honoursTags) {
    text = stripAudioTags(text).text;
  }

  const voiceId = typeof opts.voice === 'string' && opts.voice.length > 0 ? opts.voice : 'eve';
  const { codec, mime } = xaiCodecFor(opts.format);

  // Language: honour the per-worker hint if set, else auto-detect.
  // Operators set this when they want a specific accent — e.g. a
  // voice cloned in xAI's studio with French samples needs
  // `language: 'fr'` for the cloned accent to actually come through;
  // omitting it falls back to whatever the prompt text suggests.
  const language =
    typeof opts.language === 'string' && opts.language.length > 0 ? opts.language : 'auto';

  const body: Record<string, unknown> = {
    text,
    voice_id: voiceId,
    language,
    output_format: { codec },
    // text_normalization is on by default (numbers/abbreviations);
    // leaving it default. The speed knob doesn't exist on Grok TTS.
  };

  const res = await fetch(`${XAI_BASE_URL}/tts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`xai tts ${res.status}: ${errBody.slice(0, 400)}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) {
    throw new Error('xai tts: empty response body');
  }
  return {
    bytes,
    mimeType: mime,
    // Echo back the voice id as the result's `voice` field. Same cast
    // pattern as the ElevenLabs adapter — the TtsVoice union is
    // OpenAI-shaped; consumers reading this field should treat it as
    // a free-form string.
    voice: voiceId as unknown as SynthesizeResult['voice'],
    model: modelId,
  };
}

/** Discovery: xAI doesn't publish a TTS-specific /v1/models endpoint
 *  beyond the chat one, so we return the static catalog directly. */
async function xaiTtsDiscover(_apiKey: string): Promise<DiscoveryResult<TtsModelInfo>> {
  return {
    available: [
      {
        id: XAI_TTS_MODEL_ID,
        label: 'Grok voice (latest)',
        description:
          '5 voices (eve, ara, rex, sal, leo), 20+ languages auto-detected, inline + wrapping speech tags.',
        voices: XAI_TTS_VOICES.map((v) => v.id),
        supportsInstructions: false,
        tier: 'steerable',
      },
    ],
    // We don't have a way to verify access against xAI specifically
    // for TTS yet; assume the key works if the chat path does.
    filtered: false,
    error: null,
  };
}

async function xaiTtsVoicesForModel(
  _modelId: string,
): Promise<Array<{ id: string; description: string }>> {
  return XAI_TTS_VOICES.map((v) => ({ id: v.id, description: v.description }));
}

export const xaiTtsAdapter: TtsDispatcher = {
  providerId: 'xai',
  adapterName: 'xai-tts',
  synthesize: xaiTtsSynthesize,
  discoverModels: xaiTtsDiscover,
  voicesForModel: xaiTtsVoicesForModel,
  supportedAudioTags(modelId) {
    return modelId === XAI_TTS_MODEL_ID || modelId === 'grok-voice' ? XAI_AUDIO_TAGS : [];
  },
  supportedWrappingTags(modelId) {
    return modelId === XAI_TTS_MODEL_ID || modelId === 'grok-voice' ? XAI_WRAPPING_TAGS : [];
  },
};
