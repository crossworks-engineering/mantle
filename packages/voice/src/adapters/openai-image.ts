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
 *
 * Image-to-image (`inputImages`) goes to a second endpoint,
 * POST /v1/images/edits, as multipart with the reference(s) as file parts.
 * gpt-image-1 accepts several under a repeated `image[]`; dall-e-2 accepts
 * one as `image`; dall-e-3 cannot edit at all and is refused before spending.
 */

import type {
  GenerateImageOptions,
  GenerateImageResult,
  ImageGenDispatcher,
  ImageGenWarning,
} from './types';
import { OPENAI_IMAGE_DEFAULT_MODEL, OPENAI_IMAGE_MODELS } from '../catalogs/openai-image';

const OPENAI_IMAGES_URL = 'https://api.openai.com/v1/images/generations';
/** Editing is a DIFFERENT endpoint and a different encoding: multipart, with
 *  the reference picture(s) as file parts. Only gpt-image-1 and dall-e-2 do
 *  it; dall-e-3 is generate-only, which we catch before spending. */
const OPENAI_IMAGE_EDITS_URL = 'https://api.openai.com/v1/images/edits';
const OPENAI_EDIT_MODELS = ['gpt-image-1', 'dall-e-2'];

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
  // No negative prompt or seed on /v1/images/generations; `style` is
  // dall-e-3 only and `quality` dall-e-3 + gpt-image-1, both narrowed
  // per-model by the catalog's supportedStyles/supportedQualities.
  supports: ['size', 'style', 'quality', 'inputImages'],
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
    // Per-MODEL gates, which `supports` (per-provider) cannot express. What
    // doesn't go on the wire is reported, not swallowed.
    const warnings: ImageGenWarning[] = [];
    if (opts.quality) {
      if (model === 'dall-e-3' || model === 'gpt-image-1') body.quality = opts.quality;
      else warnings.push({ param: 'quality', reason: `${model} has no quality tier` });
    }
    if (opts.style) {
      if (model === 'dall-e-3') body.style = opts.style;
      else
        warnings.push({
          param: 'style',
          reason: `${model} has no style steering (only dall-e-3 does)`,
        });
    }

    // Editing swaps both the endpoint and the encoding. Everything above still
    // applies (same size validation, same per-model warnings), so the split is
    // as late as possible.
    const inputs = opts.inputImages ?? [];
    const editing = inputs.length > 0;
    if (editing && !OPENAI_EDIT_MODELS.includes(model)) {
      throw new Error(
        `openai-image: model '${model}' cannot edit an existing image (generate-only). ` +
          `Switch the image_gen worker to ${OPENAI_EDIT_MODELS.join(' or ')} at /settings/ai-workers.`,
      );
    }

    let payload: BodyInit;
    const headers: Record<string, string> = { Authorization: `Bearer ${opts.apiKey}` };
    if (editing) {
      const form = new FormData();
      for (const [k, v] of Object.entries(body)) form.append(k, String(v));
      // gpt-image-1 takes several references under the repeated `image[]`
      // key; dall-e-2 takes exactly one as `image`.
      const key = model === 'gpt-image-1' ? 'image[]' : 'image';
      for (const [i, img] of inputs.entries()) {
        form.append(
          key,
          new Blob([new Uint8Array(img.bytes)], { type: img.mimeType }),
          img.filename ?? `reference-${i}.png`,
        );
      }
      payload = form;
      // Content-Type is deliberately unset: fetch derives it WITH the
      // multipart boundary, and setting it by hand strips the boundary and
      // the request fails to parse.
    } else {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(editing ? OPENAI_IMAGE_EDITS_URL : OPENAI_IMAGES_URL, {
      method: 'POST',
      headers,
      body: payload,
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
          ...(warnings.length > 0 ? { warnings } : {}),
        };
      }
      throw new Error('openai-image: response had no b64_json or url');
    }
    return {
      bytes: Buffer.from(first.b64_json, 'base64'),
      mimeType: 'image/png',
      model,
      revisedPrompt: first.revised_prompt,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },
  staticCatalog() {
    return OPENAI_IMAGE_MODELS;
  },
};
