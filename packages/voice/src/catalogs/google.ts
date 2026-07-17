/**
 * Google (Gemini) static catalog.
 *
 * Gemini's API is NOT OpenAI-compatible. It uses `contents` (with
 * `parts`) instead of `messages`, `systemInstruction` as a separate
 * top-level field, and roles 'user' / 'model' (not 'assistant'). The
 * adapter handles the translation.
 *
 * Endpoint: POST /v1beta/models/{model}:generateContent
 * Auth: `x-goog-api-key` header
 * Models endpoint: GET /v1beta/models?key=...
 *
 * Notable Gemini quirks:
 *   - Huge context windows (1M-2M tokens) for the 3.x models.
 *   - 3.x is preview-tagged but production-stable for most uses.
 *   - Gemini also ships TTS and embedding models — we cover chat here;
 *     a separate google-tts.ts / google-embed.ts can land later.
 */

import type {
  AudioTag,
  ChatModelInfo,
  ImageGenModelInfo,
  VisionModelInfo,
} from '../adapters/types';

export const GOOGLE_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

// ─── Gemini TTS ──────────────────────────────────────────────────────
//
// Endpoint: POST {GOOGLE_BASE_URL}/models/{model}:generateContent
// Auth:     x-goog-api-key header
// Body:     contents (text), generationConfig {
//             responseModalities: ['AUDIO'],
//             speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } }
//           }
// Output:   The audio comes back inline as inlineData (base64 PCM).
//
// Gemini TTS supports BOTH inline audio tags ([whispers], [laughs])
// AND natural-language style steering inside the text itself ("Say
// excitedly: ..."). We expose tags via the adapter framework; the
// natural-language steering option remains available to operators
// who put it in the worker's system prompt.

/** Gemini TTS model ids. Two variants — Flash for low-latency / cost
 *  and Pro for studio-quality. Both are preview-tagged but production-
 *  stable for most uses. */
export const GOOGLE_TTS_MODELS = [
  'gemini-2.5-flash-preview-tts',
  'gemini-2.5-pro-preview-tts',
] as const;
export type GoogleTtsModelId = (typeof GOOGLE_TTS_MODELS)[number];

/** Gemini publishes 30 prebuilt voices. Names come from Greek/myth
 *  references; gender/character notes from the Gemini docs and
 *  cookbook samples. Operators see these in the worker form's voice
 *  dropdown. */
export const GOOGLE_TTS_VOICES = [
  // Most-used / recommended.
  { id: 'Kore', description: 'female, balanced — Gemini default' },
  { id: 'Puck', description: 'male, expressive' },
  { id: 'Zephyr', description: 'male, light and airy' },
  { id: 'Charon', description: 'male, grounded and warm' },
  { id: 'Fenrir', description: 'male, deep' },
  { id: 'Leda', description: 'female, soft' },
  { id: 'Aoede', description: 'female, melodic' },
  { id: 'Orus', description: 'male, neutral' },
  // The remaining 22 — left as id-only so the dropdown isn't bloated
  // with guessed descriptions. Live discovery surfaces all 30.
  { id: 'Callirrhoe', description: 'female' },
  { id: 'Autonoe', description: 'female' },
  { id: 'Enceladus', description: 'male' },
  { id: 'Iapetus', description: 'male' },
  { id: 'Umbriel', description: 'male' },
  { id: 'Algieba', description: 'male' },
  { id: 'Despina', description: 'female' },
  { id: 'Erinome', description: 'female' },
  { id: 'Algenib', description: 'male' },
  { id: 'Rasalgethi', description: 'male' },
  { id: 'Laomedeia', description: 'female' },
  { id: 'Achernar', description: 'female' },
  { id: 'Alnilam', description: 'male' },
  { id: 'Schedar', description: 'male' },
  { id: 'Gacrux', description: 'female' },
  { id: 'Pulcherrima', description: 'female' },
  { id: 'Achird', description: 'male' },
  { id: 'Zubenelgenubi', description: 'male' },
  { id: 'Vindemiatrix', description: 'female' },
  { id: 'Sadachbia', description: 'male' },
  { id: 'Sadaltager', description: 'male' },
  { id: 'Sulafat', description: 'female' },
] as const;

/**
 * Inline audio tags Gemini TTS interprets. The Gemini docs note that
 * tags "like [whispers] or [laughs]" are honoured but don't publish a
 * canonical exhaustive list — they describe a more open vocabulary
 * driven by natural-language understanding. We ship the documented
 * examples plus the well-known ElevenLabs-shaped ones since Gemini
 * tends to understand them too.
 *
 * If a tag in this list doesn't render perfectly on Gemini, fall
 * back to natural-language steering in the worker's system prompt
 * ("Speak softly here:", "She laughs as she says:") — Gemini handles
 * that path well.
 */
export const GOOGLE_AUDIO_TAGS: readonly AudioTag[] = [
  // Reactions — documented examples in Gemini's docs.
  { tag: '[laughs]', description: 'a warm laugh', category: 'reaction' },
  { tag: '[chuckles]', description: 'short amusement', category: 'reaction' },
  { tag: '[sighs]', description: 'a resigned exhale', category: 'reaction' },
  { tag: '[gasps]', description: 'sharp inhale of surprise', category: 'reaction' },
  { tag: '[clears throat]', description: 'transitional beat', category: 'reaction' },

  // Delivery — documented.
  { tag: '[whispers]', description: 'intimate lowered voice', category: 'delivery' },
  { tag: '[shouts]', description: 'raised voice; use sparingly', category: 'delivery' },

  // Cognitive — documented.
  { tag: '[pauses]', description: 'a deliberate beat of silence', category: 'cognitive' },

  // Emotion / tone — Gemini's natural-language steering means these
  // work reliably in bracket form too.
  { tag: '[excited]', description: 'warm, energetic delivery', category: 'emotion' },
  { tag: '[curious]', description: 'rising-inflection, inquisitive', category: 'emotion' },
  { tag: '[happy]', description: 'bright, smiling tone', category: 'emotion' },
  { tag: '[sad]', description: 'slower, weighted', category: 'emotion' },
  { tag: '[serious]', description: 'measured, weighty', category: 'emotion' },
  { tag: '[calm]', description: 'steady, unhurried', category: 'emotion' },
  { tag: '[playfully]', description: 'light, teasing', category: 'tone' },
  { tag: '[deadpan]', description: 'expressionless; dry humour', category: 'tone' },
  { tag: '[cheerfully]', description: 'lift and brightness', category: 'tone' },
];

/**
 * Audio-tag lookup per Gemini TTS model. Both Flash and Pro honour
 * the same vocabulary; the difference is fidelity, not steering.
 */
export function audioTagsForGoogleTtsModel(modelId: string): readonly AudioTag[] {
  if ((GOOGLE_TTS_MODELS as readonly string[]).includes(modelId)) {
    return GOOGLE_AUDIO_TAGS;
  }
  return [];
}

export const GOOGLE_CHAT_MODELS: readonly ChatModelInfo[] = [
  // ── Gemini 3 series (current) ────────────────────────────────────
  {
    id: 'gemini-3.1-pro-preview',
    label: 'Gemini 3.1 Pro (preview)',
    description:
      'Latest flagship. Advanced reasoning, multimodal, 2M context. Recommended default.',
    contextTokens: 2_000_000,
    capabilities: ['vision', 'reasoning', 'function_calling', 'json_mode'],
  },
  {
    id: 'gemini-3-flash-preview',
    label: 'Gemini 3 Flash (preview)',
    description: 'Frontier-class performance at low cost. Fast multimodal.',
    contextTokens: 1_000_000,
    capabilities: ['vision', 'function_calling', 'json_mode'],
  },
  {
    id: 'gemini-3.1-flash-lite',
    label: 'Gemini 3.1 Flash Lite',
    description: 'Stable Flash-Lite tier. Cheapest in the 3.x family.',
    contextTokens: 1_000_000,
    capabilities: ['vision', 'function_calling'],
  },

  // ── Gemini 2.5 series (stable, widely available) ─────────────────
  {
    id: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    description: 'Stable Pro tier. 2M context, deep reasoning, multimodal.',
    contextTokens: 2_000_000,
    capabilities: ['vision', 'reasoning', 'function_calling', 'json_mode'],
  },
  {
    id: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    description: 'Best price/perf in the 2.5 family. Multimodal.',
    contextTokens: 1_000_000,
    capabilities: ['vision', 'function_calling', 'json_mode'],
  },
  {
    id: 'gemini-2.5-flash-lite',
    label: 'Gemini 2.5 Flash Lite',
    description: 'Fastest and most budget-friendly multimodal model.',
    contextTokens: 1_000_000,
    capabilities: ['vision', 'function_calling'],
  },
];

// ─── Gemini as STT ───────────────────────────────────────────────────
//
// Unlike OpenAI / xAI / Deepgram / AssemblyAI which all expose a
// dedicated `/transcriptions` endpoint, Google ships transcription as
// "ask Gemini to transcribe this audio." The shape is the same
// generateContent call used for chat — we pass an inline audio part
// and a system prompt telling the model to output just the transcript.
//
// The catalog here only lists models that actually accept audio input.
// Older 1.5 / pre-multimodal models don't, and the adapter rejects them
// with a clear error rather than silently dropping the audio.

import type { SttModelInfo } from '../catalog';

/** Models that accept audio parts in generateContent and can return a
 *  transcript when prompted to. Per Google's docs the multimodal-input
 *  surface covers the 3.x and 2.5 lines. */
export const GOOGLE_STT_MODELS: readonly SttModelInfo[] = [
  {
    id: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    description:
      'Cheapest multimodal model. Recommended default for transcription — Gemini Pro adds little for voice.',
    supportsLanguageHint: true,
    supportsTimestamps: false,
  },
  {
    id: 'gemini-2.5-flash-lite',
    label: 'Gemini 2.5 Flash Lite',
    description: 'Fastest, lowest-cost option for short clips.',
    supportsLanguageHint: true,
    supportsTimestamps: false,
  },
  {
    id: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    description: 'Higher accuracy on noisy or accented audio. More expensive.',
    supportsLanguageHint: true,
    supportsTimestamps: false,
  },
  {
    id: 'gemini-3-flash-preview',
    label: 'Gemini 3 Flash (preview)',
    description: 'Latest Flash with stronger multilingual coverage.',
    supportsLanguageHint: true,
    supportsTimestamps: false,
  },
] as const;

// ─── Gemini Vision ───────────────────────────────────────────────────
//
// Every modern Gemini model (2.5+ and 3.x) is multimodal — same
// endpoint as chat, just an inlineData `image/jpeg` part instead of
// (or alongside) text. We surface the practical picks: Flash-Lite for
// the cheap default, Flash for the balanced choice, Pro when an image
// has dense text or diagrams worth paying more for.

export const GOOGLE_VISION_MODELS: readonly VisionModelInfo[] = [
  {
    id: 'gemini-2.5-flash-lite',
    label: 'Gemini 2.5 Flash Lite',
    description: 'Cheapest, fastest vision. Great for clean printed text and bulk receipt OCR.',
    contextTokens: 1_000_000,
    tier: 'fast',
  },
  {
    id: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    description:
      'Best price/perf. Handles handwritten notes and multi-column layouts. Recommended default.',
    contextTokens: 1_000_000,
    tier: 'balanced',
  },
  {
    id: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    description: 'Strongest accuracy on hard handwriting + diagrams. 2M context.',
    contextTokens: 2_000_000,
    tier: 'quality',
  },
  {
    id: 'gemini-3-flash-preview',
    label: 'Gemini 3 Flash (preview)',
    description: 'Latest Flash. Higher multilingual fidelity; preview-tagged but production-ok.',
    contextTokens: 1_000_000,
    tier: 'balanced',
  },
];

// ─── Google Imagen (image generation) ────────────────────────────────
//
// Endpoint: POST {GOOGLE_BASE_URL}/models/{model}:predict
//           NOTE: this is a different shape from chat's `generateContent`.
//           Body is { instances: [{prompt}], parameters: { ... } }.
// Auth:     `x-goog-api-key` header (same as the rest of Google).
// Response: { predictions: [{ bytesBase64Encoded, mimeType }] }
//
// Imagen sits behind a separate billing/quota gate from Gemini chat —
// confirm at console.cloud.google.com that the project has Imagen API
// enabled before pointing a worker here. Auth failures surface as a
// confusing 404 ("model not found") rather than 401; the adapter
// translates these into a clearer hint.
//
// Sizes accept Imagen's aspect-ratio strings ('1:1', '16:9', etc.)
// rather than NxN pixels. The adapter maps the standard 'NNNNxNNNN'
// format used elsewhere to the closest aspect ratio.

export const GOOGLE_IMAGE_MODELS: readonly ImageGenModelInfo[] = [
  {
    id: 'imagen-4.0-generate-001',
    label: 'Imagen 4',
    description: 'Current Imagen flagship. Strong on detail + composition. Recommended.',
    supportedSizes: ['1024x1024', '1408x768', '768x1408'],
    pricePerImage: 0.04,
    tier: 'quality',
  },
  {
    id: 'imagen-4.0-fast-generate-001',
    label: 'Imagen 4 Fast',
    description: 'Faster + cheaper Imagen 4 variant. Lower fidelity, higher throughput.',
    supportedSizes: ['1024x1024', '1408x768', '768x1408'],
    pricePerImage: 0.02,
    tier: 'fast',
  },
  {
    id: 'imagen-3.0-generate-002',
    label: 'Imagen 3',
    description: 'Previous-generation Imagen. Still capable + widely available.',
    supportedSizes: ['1024x1024', '1408x768', '768x1408'],
    pricePerImage: 0.04,
    tier: 'balanced',
  },
];

export const GOOGLE_IMAGE_DEFAULT_MODEL = 'imagen-4.0-generate-001';
