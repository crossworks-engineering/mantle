/**
 * Google Imagen adapter.
 *
 * Endpoint: POST {GOOGLE_BASE_URL}/models/{model}:predict
 *
 *   Different from chat's `generateContent` — Imagen uses the older
 *   `:predict` path with `instances` + `parameters`. Auth header is
 *   the same `x-goog-api-key` we use everywhere else for Google.
 *
 * Request body shape:
 *   {
 *     instances: [{ prompt: "..." }],
 *     parameters: {
 *       sampleCount: 1,
 *       aspectRatio: "1:1" | "16:9" | "9:16" | "4:3" | "3:4",
 *       negativePrompt?: string,
 *       seed?: number,
 *     }
 *   }
 *
 * Response:
 *   { predictions: [{ bytesBase64Encoded, mimeType }] }
 *
 * Size mapping: callers pass standard 'NNNNxNNNN' sizes; we map to
 * Imagen's aspect-ratio strings. The actual pixel dimensions Imagen
 * returns are 1024px on the long edge (so 1408x768 for 16:9 etc.) —
 * we surface the catalog's documented dimensions for transparency.
 *
 * Quota gotcha: Imagen requires the API to be enabled separately from
 * Gemini chat at console.cloud.google.com. Auth failures come back as
 * `404 Model not found` (instead of 401) — we rewrite the error to
 * point operators at the right console page.
 */

import type { GenerateImageOptions, GenerateImageResult, ImageGenDispatcher } from './types';
import {
  GOOGLE_BASE_URL,
  GOOGLE_IMAGE_DEFAULT_MODEL,
  GOOGLE_IMAGE_MODELS,
} from '../catalogs/google';

/** Map a 'NNNNxNNNN' size to an Imagen aspect ratio. Falls back to
 *  1:1 for unknown sizes — Imagen rejects anything else with a 400. */
function aspectRatioFor(size: string | undefined): string {
  if (!size) return '1:1';
  const m = /^(\d+)x(\d+)$/.exec(size);
  if (!m) return '1:1';
  const [w, h] = [Number(m[1]), Number(m[2])];
  const r = w / h;
  // Snap to Imagen's documented aspect ratios.
  if (Math.abs(r - 1) < 0.05) return '1:1';
  if (Math.abs(r - 16 / 9) < 0.1) return '16:9';
  if (Math.abs(r - 9 / 16) < 0.1) return '9:16';
  if (Math.abs(r - 4 / 3) < 0.1) return '4:3';
  if (Math.abs(r - 3 / 4) < 0.1) return '3:4';
  return '1:1';
}

type ImagenResponse = {
  predictions?: Array<{
    bytesBase64Encoded?: string;
    mimeType?: string;
  }>;
};

export const googleImageAdapter: ImageGenDispatcher = {
  providerId: 'google',
  adapterName: 'google-image',
  async generate(opts: GenerateImageOptions): Promise<GenerateImageResult> {
    if (!opts.apiKey) throw new Error('google-image: apiKey required');
    const prompt = opts.prompt?.trim();
    if (!prompt) throw new Error('google-image: empty prompt');

    const model = opts.model || GOOGLE_IMAGE_DEFAULT_MODEL;
    const aspectRatio = aspectRatioFor(opts.size);

    const body = {
      instances: [{ prompt }],
      parameters: {
        sampleCount: 1,
        aspectRatio,
        ...(opts.negativePrompt ? { negativePrompt: opts.negativePrompt } : {}),
        ...(typeof opts.seed === 'number' ? { seed: opts.seed } : {}),
      },
    };

    const url = `${GOOGLE_BASE_URL}/models/${encodeURIComponent(model)}:predict`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'x-goog-api-key': opts.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      // Translate the misleading 404 into something an operator can
      // actually act on. Imagen access is a separate enablement step
      // from regular Gemini API access, and the API surfaces this as
      // "model not found" rather than the more honest 403.
      if (res.status === 404 && /not found/i.test(errBody)) {
        throw new Error(
          `google-image: model '${model}' not accessible. Imagen is gated separately from Gemini — ` +
            `enable it at console.cloud.google.com → APIs & Services → Imagen API, ` +
            `then verify the key has access.`,
        );
      }
      throw new Error(`google-image ${res.status}: ${errBody.slice(0, 400)}`);
    }
    const parsed = (await res.json()) as ImagenResponse;
    const first = parsed.predictions?.[0];
    if (!first?.bytesBase64Encoded) {
      throw new Error('google-image: no bytesBase64Encoded in response');
    }
    return {
      bytes: Buffer.from(first.bytesBase64Encoded, 'base64'),
      mimeType: first.mimeType || 'image/png',
      model,
    };
  },
  staticCatalog() {
    return GOOGLE_IMAGE_MODELS;
  },
};
