/**
 * Hugging Face image-generation adapter.
 *
 * Endpoint: POST {HUGGINGFACE_INFERENCE_BASE_URL}/models/{repo-id}
 *
 *   This is the older `api-inference.huggingface.co` host — NOT the
 *   chat router. HF doesn't proxy image tasks through their OpenAI-
 *   compatible router yet; the inference API takes a different shape
 *   per task. For text-to-image the body is:
 *     { inputs: <prompt>, parameters: { negative_prompt, seed,
 *                                       num_inference_steps,
 *                                       guidance_scale,
 *                                       width, height } }
 *   and the response is raw image bytes with a Content-Type header.
 *
 *   The repo id is the model: 'black-forest-labs/FLUX.1-schnell',
 *   'stabilityai/stable-diffusion-3.5-large', etc. Operators can type
 *   any image-task repo into the worker form — the adapter passes it
 *   through verbatim.
 *
 * Cold-start gotcha: HF spins up serverless inference workers on
 * demand. First request after idle returns a 503 with `estimated_time`
 * in the body. We surface a clearer hint pointing operators at the
 * loading state rather than burying it in a raw 503.
 *
 * Auth: Bearer with an `hf_...` access token (Pro plan recommended
 * for image gen; the free tier is severely rate-limited and a lot
 * of larger models are gated).
 */

import type {
  GenerateImageOptions,
  GenerateImageResult,
  ImageGenDispatcher,
} from './types';
import {
  HUGGINGFACE_INFERENCE_BASE_URL,
  HUGGINGFACE_IMAGE_DEFAULT_MODEL,
  HUGGINGFACE_IMAGE_MODELS,
} from '../catalogs/huggingface';

/** Parse 'NNNNxNNNN' into separate width/height. Returns undefined
 *  for HF's "let the model decide" path when size isn't specified. */
function parseSize(size: string | undefined): { width: number; height: number } | undefined {
  if (!size) return undefined;
  const m = /^(\d+)x(\d+)$/.exec(size);
  if (!m) return undefined;
  return { width: Number(m[1]), height: Number(m[2]) };
}

export const huggingfaceImageAdapter: ImageGenDispatcher = {
  providerId: 'huggingface',
  adapterName: 'huggingface-image',
  async generate(opts: GenerateImageOptions): Promise<GenerateImageResult> {
    if (!opts.apiKey) throw new Error('huggingface-image: apiKey required');
    const prompt = opts.prompt?.trim();
    if (!prompt) throw new Error('huggingface-image: empty prompt');

    const model = opts.model || HUGGINGFACE_IMAGE_DEFAULT_MODEL;
    const wh = parseSize(opts.size);
    const parameters: Record<string, unknown> = {
      ...(opts.negativePrompt ? { negative_prompt: opts.negativePrompt } : {}),
      ...(typeof opts.seed === 'number' ? { seed: opts.seed } : {}),
      ...(wh ? { width: wh.width, height: wh.height } : {}),
    };

    const body = {
      inputs: prompt,
      ...(Object.keys(parameters).length > 0 ? { parameters } : {}),
    };

    const url = `${HUGGINGFACE_INFERENCE_BASE_URL}/models/${encodeURI(model)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
        // Accept tells HF to return image bytes, not JSON wrapping.
        Accept: 'image/png,image/jpeg',
      },
      body: JSON.stringify(body),
      // HF cold starts can run 30s+ on first call after idle.
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      // Translate cold-start 503s into a clearer message so the
      // operator knows to retry rather than thinking the model is
      // broken.
      if (res.status === 503 && /loading|estimated_time/i.test(errBody)) {
        const m = /"estimated_time"\s*:\s*([\d.]+)/.exec(errBody);
        const wait = m ? Math.ceil(Number(m[1])) : 30;
        throw new Error(
          `huggingface-image: model '${model}' is cold-starting on HF serverless. ` +
            `Retry in ~${wait}s. (HF spins workers up on demand.)`,
        );
      }
      throw new Error(`huggingface-image ${res.status}: ${errBody.slice(0, 400)}`);
    }
    const contentType = res.headers.get('content-type') || 'image/png';
    if (!contentType.startsWith('image/')) {
      // HF sometimes returns a JSON error body with a 200 — the
      // server says "everything's fine" but the body is `{error:
      // 'Model X is not deployed', ...}`. Detect and surface.
      const text = await res.text().catch(() => '');
      throw new Error(
        `huggingface-image: expected image bytes, got ${contentType}: ${text.slice(0, 300)}`,
      );
    }
    return {
      bytes: Buffer.from(await res.arrayBuffer()),
      mimeType: contentType,
      model,
    };
  },
  staticCatalog() {
    return HUGGINGFACE_IMAGE_MODELS;
  },
};
