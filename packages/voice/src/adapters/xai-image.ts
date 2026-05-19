/**
 * xAI image-generation adapter (Grok 2 Image).
 *
 * Endpoint: POST {XAI_BASE_URL}/images/generations
 * Auth:     Bearer
 *
 * The xAI image API is OpenAI-shaped with two specifics:
 *   - `response_format` MUST be 'b64_json' to get bytes (default
 *     is 'url' which we have to fetch separately).
 *   - Style + quality + size hints are ignored — Grok 2 Image only
 *     supports 1024x1024 and has no style steering today. We send
 *     them anyway and let xAI's server drop unknown fields; the
 *     adapter's job is to be uniform, not pedantic.
 */

import type {
  GenerateImageOptions,
  GenerateImageResult,
  ImageGenDispatcher,
} from './types';
import {
  XAI_BASE_URL,
  XAI_IMAGE_DEFAULT_MODEL,
  XAI_IMAGE_DEPRECATED_MODELS,
  XAI_IMAGE_MODELS,
} from '../catalogs/xai';

type XaiImageResponse = {
  data?: Array<{
    b64_json?: string;
    url?: string;
    revised_prompt?: string;
  }>;
};

export const xaiImageAdapter: ImageGenDispatcher = {
  providerId: 'xai',
  adapterName: 'xai-image',
  async generate(opts: GenerateImageOptions): Promise<GenerateImageResult> {
    if (!opts.apiKey) throw new Error('xai-image: apiKey required');
    const prompt = opts.prompt?.trim();
    if (!prompt) throw new Error('xai-image: empty prompt');

    const model = opts.model || XAI_IMAGE_DEFAULT_MODEL;

    const body: Record<string, unknown> = {
      model,
      prompt,
      n: 1,
      response_format: 'b64_json',
    };

    const res = await fetch(`${XAI_BASE_URL}/images/generations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      // Rewrite the deprecation 404 into an actionable migration
      // hint. xAI returns a 404 "model X was deprecated" rather
      // than a 410-Gone, which makes the actual cause hard to spot
      // alongside "model not found" errors from typos.
      if (
        res.status === 404 &&
        (XAI_IMAGE_DEPRECATED_MODELS.includes(model) ||
          /deprecated|no longer accessible/i.test(errBody))
      ) {
        throw new Error(
          `xai-image: model '${model}' is deprecated by xAI. ` +
            `Edit your image_gen worker at /settings/ai-workers and set ` +
            `model to '${XAI_IMAGE_DEFAULT_MODEL}' (current default).`,
        );
      }
      throw new Error(`xai-image ${res.status}: ${errBody.slice(0, 400)}`);
    }
    const parsed = (await res.json()) as XaiImageResponse;
    const first = parsed.data?.[0];
    if (!first?.b64_json) {
      if (first?.url) {
        const imgRes = await fetch(first.url);
        if (!imgRes.ok) {
          throw new Error(`xai-image: failed to fetch returned URL (${imgRes.status})`);
        }
        return {
          bytes: Buffer.from(await imgRes.arrayBuffer()),
          mimeType: imgRes.headers.get('content-type') || 'image/jpeg',
          model,
          revisedPrompt: first.revised_prompt,
        };
      }
      throw new Error('xai-image: response had no b64_json or url');
    }
    return {
      bytes: Buffer.from(first.b64_json, 'base64'),
      // xAI returns JPEGs by default for Grok 2 Image. If a future
      // variant switches to PNG the content-type from a URL fallback
      // path would override; for the inline-b64 path we trust the
      // documented format.
      mimeType: 'image/jpeg',
      model,
      revisedPrompt: first.revised_prompt,
    };
  },
  staticCatalog() {
    return XAI_IMAGE_MODELS;
  },
};
