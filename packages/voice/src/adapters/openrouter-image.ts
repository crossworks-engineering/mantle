/**
 * OpenRouter image-generation adapter.
 *
 * Unlike OpenAI's dedicated `/images/generations`, OpenRouter generates images
 * through the **chat** endpoint: POST /api/v1/chat/completions with
 * `modalities: ['image','text']`. The generated image comes back as a base64
 * data URL at `choices[0].message.images[0].image_url.url`. Routes to Google
 * Gemini image, Black Forest Labs FLUX, etc. behind one key.
 *
 * Docs: https://openrouter.ai/docs/guides/overview/multimodal/image-generation
 */

import type { ImageGenDispatcher, ImageGenModelInfo } from './types';
import type { GenerateImageOptions, GenerateImageResult } from './types';
import { OPENROUTER_BASE_URL } from '../catalogs/openrouter';

export const OPENROUTER_IMAGE_DEFAULT_MODEL = 'google/gemini-3.1-flash-image-preview';

const OPENROUTER_IMAGE_MODELS: readonly ImageGenModelInfo[] = [
  {
    id: 'google/gemini-3.1-flash-image-preview',
    label: 'Gemini 3.1 Flash Image',
    description: 'Google fast image generation. Good default — quick and inexpensive.',
    tier: 'fast',
  },
  {
    id: 'google/gemini-2.5-flash-image',
    label: 'Gemini 2.5 Flash Image',
    description: 'Google image generation, prior generation. Reliable general-purpose.',
    tier: 'balanced',
  },
  {
    id: 'black-forest-labs/flux.2-pro',
    label: 'FLUX.2 Pro',
    description: 'Black Forest Labs flagship. High-fidelity, photographic detail.',
    tier: 'quality',
  },
];

/** Parse a `data:image/png;base64,…` URL into bytes + mime. */
function decodeDataUrl(url: string): { bytes: Buffer; mimeType: string } | null {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
  if (!m) return null;
  return { bytes: Buffer.from(m[2]!, 'base64'), mimeType: m[1] || 'image/png' };
}

type OpenRouterImageResponse = {
  choices?: Array<{
    message?: {
      content?: string;
      images?: Array<{ image_url?: { url?: string } }>;
    };
  }>;
};

export const openrouterImageAdapter: ImageGenDispatcher = {
  providerId: 'openrouter',
  adapterName: 'openrouter-image',
  async generate(opts: GenerateImageOptions): Promise<GenerateImageResult> {
    if (!opts.apiKey) throw new Error('openrouter-image: apiKey required');
    const prompt = opts.prompt?.trim();
    if (!prompt) throw new Error('openrouter-image: empty prompt');

    const model = opts.model || OPENROUTER_IMAGE_DEFAULT_MODEL;
    const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'content-type': 'application/json',
        'HTTP-Referer': 'https://mantle.crossworks.network',
        'X-Title': 'Mantle',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        modalities: ['image', 'text'],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`openrouter-image ${res.status}: ${body.slice(0, 400)}`);
    }
    const parsed = (await res.json()) as OpenRouterImageResponse;
    const url = parsed.choices?.[0]?.message?.images?.[0]?.image_url?.url;
    if (!url) {
      throw new Error(
        'openrouter-image: response contained no image (model may not support image output)',
      );
    }
    const decoded = decodeDataUrl(url);
    if (!decoded) {
      throw new Error('openrouter-image: image_url was not a base64 data URL');
    }
    return {
      bytes: decoded.bytes,
      mimeType: decoded.mimeType,
      model,
      ...(parsed.choices?.[0]?.message?.content
        ? { revisedPrompt: parsed.choices[0].message.content }
        : {}),
    };
  },
  staticCatalog() {
    return OPENROUTER_IMAGE_MODELS;
  },
};
