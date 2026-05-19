/**
 * OpenAI image-generation catalog.
 *
 * Endpoint: POST https://api.openai.com/v1/images/generations
 * Auth:     Bearer
 *
 * Models we surface in the worker form (May 2026 reality):
 *
 *   - `gpt-image-1`: the current default. Native multimodal model,
 *     returns base64 by default (no `response_format` switch needed).
 *     Better instruction-following than DALL-E for text-in-image.
 *     ~$0.04-0.17 per image depending on size/quality.
 *   - `dall-e-3`: still around but on the way out. Use when you
 *     specifically need its style-steering ('vivid'/'natural').
 *     Returns URLs by default; the adapter requests b64_json so we
 *     get bytes uniformly.
 *   - `dall-e-2`: legacy. Cheap (~$0.02 per image), lower quality.
 *     Useful for high-volume placeholder generation.
 *
 * Why no live discovery: OpenAI's /v1/models endpoint returns ALL
 * models the key can use (chat, embeddings, etc.) — not just image
 * ones. We could filter by name prefix but the catalog stays simpler
 * + clearer if we ship the curated list and skip discovery for image
 * gen.
 */

import type { ImageGenModelInfo } from '../adapters/types';

export const OPENAI_IMAGE_MODELS: readonly ImageGenModelInfo[] = [
  {
    id: 'gpt-image-1',
    label: 'gpt-image-1',
    description:
      'Current OpenAI default. Best text-in-image rendering, strong instruction-following. Recommended.',
    supportedSizes: ['1024x1024', '1024x1536', '1536x1024'],
    pricePerImage: 0.07,
    tier: 'balanced',
  },
  {
    id: 'dall-e-3',
    label: 'DALL-E 3',
    description:
      'Steerable with style=vivid|natural. Good for stylised art; gpt-image-1 beats it for realism + text.',
    supportedSizes: ['1024x1024', '1024x1792', '1792x1024'],
    supportedStyles: ['vivid', 'natural'],
    pricePerImage: 0.08,
    tier: 'quality',
  },
  {
    id: 'dall-e-2',
    label: 'DALL-E 2 (legacy)',
    description:
      'Older, cheaper. ~$0.02 per image. Use when quality matters less than throughput.',
    supportedSizes: ['256x256', '512x512', '1024x1024'],
    pricePerImage: 0.02,
    tier: 'fast',
  },
];

/** Default model for openai-image when no worker.model is set. */
export const OPENAI_IMAGE_DEFAULT_MODEL = 'gpt-image-1';
