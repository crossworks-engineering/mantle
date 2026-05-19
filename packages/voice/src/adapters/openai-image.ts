/**
 * OpenAI image-generation adapter (gpt-image-1 + DALL-E).
 *
 * Endpoint: POST https://api.openai.com/v1/images/generations
 * Auth:     Bearer
 *
 * Per-model nuances we handle:
 *
 *   - `gpt-image-1`  →  ALWAYS returns base64 (no response_format
 *      switch needed). Accepts `quality` ('low'|'medium'|'high'|'auto')
 *      and `size` (1024x1024 default). No `style` param.
 *   - `dall-e-3`     →  defaults to URL; we force `response_format=
 *      'b64_json'` so callers get bytes uniformly. Accepts `style`
 *      ('vivid'|'natural') and `quality` ('standard'|'hd').
 *   - `dall-e-2`     →  same as dall-e-3 minus style/quality. Accepts
 *      sizes 256x256, 512x512, 1024x1024.
 *
 * The adapter normalises these so callers pass the same options shape
 * regardless of model. Adapter-side validation rejects sizes that
 * aren't in the model's supportedSizes list with a clear hint.
 */

import type {
  GenerateImageOptions,
  GenerateImageResult,
  ImageGenDispatcher,
} from './types';
import {
  OPENAI_IMAGE_DEFAULT_MODEL,
  OPENAI_IMAGE_MODELS,
} from '../catalogs/openai-image';

const OPENAI_IMAGES_URL = 'https://api.openai.com/v1/images/generations';

type OpenAiImageResponse = {
  data?: Array<{
    b64_json?: string;
    url?: string;
    revised_prompt?: string;
  }>;
};

function validateSize(model: string, size: string | undefined): string | undefined {
  if (!size) return undefined;
  const entry = OPENAI_IMAGE_MODELS.find((m) => m.id === model);
  if (entry?.supportedSizes && !entry.supportedSizes.includes(size)) {
    throw new Error(
      `openai-image: model '${model}' doesn't support size '${size}'. Allowed: ${entry.supportedSizes.join(', ')}.`,
    );
  }
  return size;
}

export const openAiImageAdapter: ImageGenDispatcher = {
  providerId: 'openai',
  adapterName: 'openai-image',
  async generate(opts: GenerateImageOptions): Promise<GenerateImageResult> {
    if (!opts.apiKey) throw new Error('openai-image: apiKey required');
    const prompt = opts.prompt?.trim();
    if (!prompt) throw new Error('openai-image: empty prompt');

    const model = opts.model || OPENAI_IMAGE_DEFAULT_MODEL;
    const size = validateSize(model, opts.size);

    // Build the request body conditionally — dall-e-3 takes
    // response_format, gpt-image-1 doesn't (it always returns b64).
    // Sending response_format to gpt-image-1 returns a 400.
    const body: Record<string, unknown> = {
      model,
      prompt,
      n: 1,
      ...(size ? { size } : {}),
    };
    if (model === 'dall-e-3' || model === 'dall-e-2') {
      body.response_format = 'b64_json';
    }
    if (opts.quality && (model === 'dall-e-3' || model === 'gpt-image-1')) {
      body.quality = opts.quality;
    }
    if (opts.style && model === 'dall-e-3') {
      body.style = opts.style;
    }

    const res = await fetch(OPENAI_IMAGES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      // Image generation can take 20-40s on dall-e-3 hd; give plenty.
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`openai-image ${res.status}: ${errBody.slice(0, 400)}`);
    }
    const parsed = (await res.json()) as OpenAiImageResponse;
    const first = parsed.data?.[0];
    if (!first?.b64_json) {
      // Defensive: gpt-image-1 should always return b64; if a future
      // model drops to url-only we need to fetch the URL ourselves
      // here. Not silently going to send the operator a half-baked
      // result.
      if (first?.url) {
        const imgRes = await fetch(first.url);
        if (!imgRes.ok) {
          throw new Error(`openai-image: failed to fetch returned URL (${imgRes.status})`);
        }
        const bytes = Buffer.from(await imgRes.arrayBuffer());
        return {
          bytes,
          mimeType: imgRes.headers.get('content-type') || 'image/png',
          model,
          revisedPrompt: first.revised_prompt,
        };
      }
      throw new Error('openai-image: response had no b64_json or url');
    }
    return {
      bytes: Buffer.from(first.b64_json, 'base64'),
      mimeType: 'image/png',
      model,
      revisedPrompt: first.revised_prompt,
    };
  },
  staticCatalog() {
    return OPENAI_IMAGE_MODELS;
  },
};
