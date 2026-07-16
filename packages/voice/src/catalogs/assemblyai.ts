/**
 * AssemblyAI static catalog.
 *
 * AssemblyAI's transcription API is a two-step async job:
 *   1. POST /v2/upload   — binary body, returns a temporary upload URL.
 *   2. POST /v2/transcript with `{audio_url, speech_model, language_code}`
 *      — returns a transcript id with status='queued' or 'processing'.
 *   3. Poll GET /v2/transcript/{id} until status='completed' (or 'error').
 *
 * Because of step 3, AssemblyAI is unsuitable for ultra-low-latency
 * use cases — the round trip for a short voice note is 2-5 seconds
 * even when the model itself is fast. We use it when the operator
 * specifically wants diarization or sentiment, which AssemblyAI
 * exposes alongside the base transcript.
 *
 * Speech models (May 2026): the "universal" tier is the current
 * default; "best" and "nano" are documented but billing tiers vary by
 * account. We surface the documented values; the adapter passes the
 * id through to AssemblyAI as `speech_model` in the request body.
 */

import type { SttModelInfo } from '../catalog';

export const ASSEMBLYAI_BASE_URL = 'https://api.assemblyai.com';

/** Hard cap on polling — if the transcript isn't done after this many
 *  seconds, the adapter gives up rather than blocking the test action
 *  forever. AssemblyAI's docs say 95% of jobs finish in under 35s for
 *  audio under 5 minutes, so 60s is a generous upper bound. */
export const ASSEMBLYAI_POLL_TIMEOUT_SECONDS = 60;

export const ASSEMBLYAI_STT_MODELS: readonly SttModelInfo[] = [
  {
    id: 'universal',
    label: 'Universal',
    description: 'Default tier. Balanced accuracy + speed, 99 languages.',
    supportsLanguageHint: true,
    supportsTimestamps: true,
  },
  {
    id: 'best',
    label: 'Best',
    description: 'Highest-accuracy tier. Slower + pricier than universal; good for hard audio.',
    supportsLanguageHint: true,
    supportsTimestamps: true,
  },
  {
    id: 'nano',
    label: 'Nano',
    description: 'Cheap, fast, lower accuracy. Use for clean audio at scale.',
    supportsLanguageHint: true,
    supportsTimestamps: true,
  },
] as const;
