/**
 * OpenAI vision model catalog.
 *
 * Every gpt-4o family model accepts image_url content parts; older
 * gpt-4-vision-preview is still around but deprecated. We list the
 * three operators are most likely to pick:
 *
 *   - gpt-4o-mini: ~10x cheaper than gpt-4o. Strong on printed text
 *     and clean handwriting. Good default for the photo-of-notes
 *     case the user mentioned.
 *   - gpt-4o: full quality. Better on cursive, faint pencil, and
 *     multi-column layouts. Use when mini misses too much.
 *   - gpt-4-vision-preview: legacy. Don't pick this unless you have
 *     a specific reason — discoverModels still surfaces it if the
 *     account has access.
 *
 * Endpoint is shared with chat: POST /v1/chat/completions. The image
 * goes in messages[].content as `{type: 'image_url', image_url: {url:
 * 'data:image/jpeg;base64,...'}}`. Adapter handles the encoding.
 */

import type { VisionModelInfo } from '../adapters/types';

export const OPENAI_VISION_MODELS: readonly VisionModelInfo[] = [
  {
    id: 'gpt-4o-mini',
    label: 'gpt-4o-mini',
    description:
      'Cheap, fast vision. Recommended default for high-volume OCR of notes, receipts, screenshots.',
    contextTokens: 128_000,
    inputPricePer1M: 0.15,
    outputPricePer1M: 0.6,
    tier: 'fast',
  },
  {
    id: 'gpt-4o',
    label: 'gpt-4o',
    description:
      'Full-quality vision. Use when gpt-4o-mini misreads cursive or you need diagram/chart comprehension alongside text.',
    contextTokens: 128_000,
    inputPricePer1M: 2.5,
    outputPricePer1M: 10,
    tier: 'balanced',
  },
  {
    id: 'gpt-4-vision-preview',
    label: 'gpt-4-vision-preview (legacy)',
    description:
      'Deprecated. Kept here only so existing workers configured for it still appear in the dropdown.',
    contextTokens: 128_000,
    tier: 'quality',
  },
];
