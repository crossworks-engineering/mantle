/**
 * Deepgram static catalog.
 *
 * Deepgram's transcription API is shaped quite differently from
 * OpenAI's:
 *   - Endpoint: POST https://api.deepgram.com/v1/listen
 *   - Auth: `Authorization: Token <api-key>` (not Bearer)
 *   - Body: raw audio bytes (NOT multipart) — Content-Type header
 *     carries the mime so Deepgram knows the codec.
 *   - Model + language + features go as URL query params, not body
 *     fields. E.g. `?model=nova-3&language=en&smart_format=true`.
 *
 * Models below mirror the documented "general" line as of May 2026.
 * Nova-3 is the current flagship. Older nova-2 is kept around for
 * cost-sensitive callers; enhanced/base are legacy tiers some
 * accounts still default to.
 *
 * Discovery: Deepgram has a `/v1/projects/{id}/models` endpoint, but
 * it requires the project id alongside the API key — and the project
 * id isn't carried by api_keys today (just the key string). We skip
 * live discovery and ship the static catalog. Operators can type a
 * custom model id in the form if a new variant ships before the
 * catalog is updated.
 */

import type { SttModelInfo } from '../catalog';

export const DEEPGRAM_BASE_URL = 'https://api.deepgram.com';

export const DEEPGRAM_STT_MODELS: readonly SttModelInfo[] = [
  {
    id: 'nova-3',
    label: 'Nova 3',
    description:
      'Current flagship. Best accuracy across 36 languages, lowest latency in the lineup.',
    supportsLanguageHint: true,
    supportsTimestamps: true,
  },
  {
    id: 'nova-2',
    label: 'Nova 2',
    description:
      'Previous-gen flagship. Slightly lower accuracy than Nova 3 but cheaper per minute.',
    supportsLanguageHint: true,
    supportsTimestamps: true,
  },
  {
    id: 'enhanced',
    label: 'Enhanced',
    description: 'Legacy tier. Use Nova 3 unless you have a contract reason to pin this.',
    supportsLanguageHint: true,
    supportsTimestamps: true,
  },
  {
    id: 'base',
    label: 'Base',
    description: 'Cheapest tier; lowest accuracy. Fine for clean studio audio.',
    supportsLanguageHint: true,
    supportsTimestamps: true,
  },
] as const;
