/**
 * OpenRouter image-generation adapter.
 *
 * Endpoint: POST /api/v1/images  →  { created, data: [{ b64_json, media_type }], usage }
 *
 * This was previously routed through the **chat** endpoint with
 * `modalities: ['image','text']`, reading the picture back out of
 * `choices[0].message.images[0]`. That path takes a model and a prompt and
 * nothing else, so every sizing option a caller passed was dropped on the
 * floor: an operator's saved `{size, style, quality}` never reached OpenRouter
 * and no trace said so. The dedicated endpoint accepts the controls, so we use
 * it and declare honestly (via `supports`) what still does not apply.
 *
 * Sizing on OpenRouter is normalized ACROSS providers, which is what makes it
 * determinable at all here — the underlying model may be Google, BFL or
 * ByteDance behind one slug:
 *   · `size`         tier ('1K'/'2K'/'4K') or explicit pixels ('2048x2048').
 *                    Explicit pixels are authoritative; pairing them with a
 *                    conflicting `resolution`/`aspect_ratio` is a 400, so we
 *                    send exactly one sizing key.
 *   · `aspect_ratio` normalized ratio, or 'auto' to let the provider choose.
 *   · `quality`      'auto' | 'low' | 'medium' | 'high'.
 * Providers clamp to their own supported subset.
 *
 * Docs: https://openrouter.ai/docs/guides/overview/multimodal/image-generation
 */

import type { ImageGenDispatcher, ImageGenModelInfo } from './types';
import type { GenerateImageOptions, GenerateImageResult } from './types';
import { OPENROUTER_BASE_URL } from '../catalogs/openrouter';

export const OPENROUTER_IMAGE_DEFAULT_MODEL = 'google/gemini-3.1-flash-image-preview';

/** Tiers + ratios OpenRouter normalizes for every image model it fronts.
 *  Shared by the catalog entries below and, through them, by the tool schema
 *  the assistant sees. */
const OPENROUTER_SIZE_TIERS = ['512', '1K', '2K', '4K'] as const;
const OPENROUTER_ASPECT_RATIOS = [
  'auto',
  '1:1',
  '16:9',
  '9:16',
  '4:3',
  '3:4',
  '3:2',
  '2:3',
  '4:5',
  '5:4',
  '21:9',
  '9:21',
] as const;
const OPENROUTER_QUALITIES = ['auto', 'low', 'medium', 'high'] as const;

const OPENROUTER_IMAGE_MODELS: readonly ImageGenModelInfo[] = [
  {
    id: 'google/gemini-3.1-flash-image-preview',
    label: 'Gemini 3.1 Flash Image',
    description: 'Google fast image generation. Good default — quick and inexpensive.',
    supportedSizes: OPENROUTER_SIZE_TIERS,
    supportedAspectRatios: OPENROUTER_ASPECT_RATIOS,
    supportedQualities: OPENROUTER_QUALITIES,
    tier: 'fast',
  },
  {
    id: 'google/gemini-2.5-flash-image',
    label: 'Gemini 2.5 Flash Image',
    description: 'Google image generation, prior generation. Reliable general-purpose.',
    supportedSizes: OPENROUTER_SIZE_TIERS,
    supportedAspectRatios: OPENROUTER_ASPECT_RATIOS,
    supportedQualities: OPENROUTER_QUALITIES,
    tier: 'balanced',
  },
  {
    id: 'black-forest-labs/flux.2-pro',
    label: 'FLUX.2 Pro',
    description: 'Black Forest Labs flagship. High-fidelity, photographic detail.',
    supportedSizes: OPENROUTER_SIZE_TIERS,
    supportedAspectRatios: OPENROUTER_ASPECT_RATIOS,
    supportedQualities: OPENROUTER_QUALITIES,
    tier: 'quality',
  },
];

/** `NNNNxNNNN`, the explicit-pixel form of `size`. Anything else (a tier) is
 *  sent as-is and normalized server-side. */
const PIXEL_SIZE_RE = /^\d{2,5}x\d{2,5}$/i;

type OpenRouterImageResponse = {
  data?: Array<{ b64_json?: string; media_type?: string }>;
};

export const openrouterImageAdapter: ImageGenDispatcher = {
  providerId: 'openrouter',
  adapterName: 'openrouter-image',
  // No style steering (OpenRouter has no equivalent of DALL-E's vivid/natural)
  // and no negative prompt on this endpoint.
  supports: ['size', 'aspectRatio', 'quality', 'seed', 'inputImages'],
  async generate(opts: GenerateImageOptions): Promise<GenerateImageResult> {
    if (!opts.apiKey) throw new Error('openrouter-image: apiKey required');
    const prompt = opts.prompt?.trim();
    if (!prompt) throw new Error('openrouter-image: empty prompt');

    const model = opts.model || OPENROUTER_IMAGE_DEFAULT_MODEL;

    // Explicit pixels are authoritative and reject a companion aspect_ratio
    // with a 400, so an explicit size wins and the ratio is left off.
    const explicitPixels = !!opts.size && PIXEL_SIZE_RE.test(opts.size);
    // Image-to-image: the references ride as data URLs, same encoding the
    // response comes back in. With these present the model EDITS rather than
    // invents, which is what makes "change the sky in that one" possible
    // without paying for a fresh unrelated picture.
    const inputs = opts.inputImages ?? [];

    const body: Record<string, unknown> = {
      model,
      prompt,
      ...(inputs.length > 0
        ? {
            input_references: inputs.map(
              (i) => `data:${i.mimeType};base64,${i.bytes.toString('base64')}`,
            ),
          }
        : {}),
      ...(opts.size ? { size: opts.size } : {}),
      ...(opts.aspectRatio && !explicitPixels ? { aspect_ratio: opts.aspectRatio } : {}),
      ...(opts.quality ? { quality: opts.quality } : {}),
      ...(typeof opts.seed === 'number' ? { seed: opts.seed } : {}),
    };

    const res = await fetch(`${OPENROUTER_BASE_URL}/images`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'content-type': 'application/json',
        'HTTP-Referer': 'https://mantle.crossworks.network',
        'X-Title': 'Mantle',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`openrouter-image ${res.status}: ${errBody.slice(0, 400)}`);
    }
    const parsed = (await res.json()) as OpenRouterImageResponse;
    const first = parsed.data?.[0];
    if (!first?.b64_json) {
      throw new Error(
        'openrouter-image: response contained no image (model may not support image output)',
      );
    }
    return {
      bytes: Buffer.from(first.b64_json, 'base64'),
      mimeType: first.media_type || 'image/png',
      model,
    };
  },
  staticCatalog() {
    return OPENROUTER_IMAGE_MODELS;
  },
};
