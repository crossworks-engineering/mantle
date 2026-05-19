/**
 * Google (Gemini) vision adapter.
 *
 * Endpoint: POST {GOOGLE_BASE_URL}/models/{model}:generateContent
 * Auth:     `x-goog-api-key` header
 * Shape:    Same generateContent call used for chat + STT, with an
 *           inline `image/...` part in `contents[].parts`:
 *             {
 *               systemInstruction: { parts: [{ text: <system> }] },
 *               contents: [{ role: 'user', parts: [
 *                 { inlineData: { mimeType: 'image/jpeg', data: '<base64>' } },
 *                 { text: <prompt> },
 *               ]}],
 *             }
 *
 * Inline-data limit: 20 MB per request. The Files API supports larger,
 * but our use case (note photos, screenshots) fits well under. If we
 * ever need bigger images this adapter will need a Files API branch
 * — guarding here so an oversized buffer fails loudly instead of
 * silently truncating.
 *
 * Why temperature isn't pinned to 0 here (unlike google-stt): vision
 * extraction sometimes benefits from a small amount of model
 * creativity for hard handwriting (the model considers alternatives).
 * For pure-OCR runs operators can set temperature=0 in the worker
 * params; the default leaves it implicit.
 */

import type {
  VisionDispatcher,
  VisionExtractOptions,
  VisionExtractResult,
  VisionModelInfo,
} from './types';
import type { DiscoveryResult } from '../discover';
import { GOOGLE_BASE_URL, GOOGLE_VISION_MODELS } from '../catalogs/google';

const DEFAULT_MODEL = 'gemini-2.5-flash';
const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const INLINE_MAX_BYTES = 20 * 1024 * 1024;

type GeminiInlineDataPart = { inlineData: { mimeType: string; data: string } };
type GeminiTextPart = { text: string };

type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: GeminiTextPart[] } }>;
  modelVersion?: string;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
};

type GeminiListModelsResponse = {
  models?: Array<{
    name: string;
    supportedGenerationMethods?: string[];
  }>;
};

export const googleVisionAdapter: VisionDispatcher = {
  providerId: 'google',
  adapterName: 'google-vision',
  async extract(image: Buffer, opts: VisionExtractOptions): Promise<VisionExtractResult> {
    if (!opts.apiKey) throw new Error('google-vision: apiKey required');
    if (!image || image.length === 0) throw new Error('google-vision: empty image buffer');
    if (!ALLOWED_MIMES.has(opts.mimeType)) {
      throw new Error(
        `google-vision: unsupported mime '${opts.mimeType}'. Gemini accepts jpeg/png/webp/heic/heif.`,
      );
    }
    if (image.length > INLINE_MAX_BYTES) {
      throw new Error(
        `google-vision: image is ${(image.length / 1024 / 1024).toFixed(1)} MB; Gemini's inline-data path caps at 20 MB. ` +
          `Resize or implement the Files API upload path.`,
      );
    }
    const model = opts.model || DEFAULT_MODEL;

    const imagePart: GeminiInlineDataPart = {
      inlineData: { mimeType: opts.mimeType, data: image.toString('base64') },
    };
    const body: Record<string, unknown> = {
      contents: [
        {
          role: 'user',
          parts: [imagePart, { text: opts.prompt }],
        },
      ],
      generationConfig: {
        maxOutputTokens: opts.maxTokens ?? 2000,
      },
    };
    if (opts.systemPrompt && opts.systemPrompt.trim()) {
      body.systemInstruction = { parts: [{ text: opts.systemPrompt }] };
    }

    const url = `${GOOGLE_BASE_URL}/models/${encodeURIComponent(model)}:generateContent`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'x-goog-api-key': opts.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`google-vision ${res.status}: ${errBody.slice(0, 400)}`);
    }
    const parsed = (await res.json()) as GeminiResponse;
    const text = (parsed.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('')
      .trim();
    return {
      text,
      model: parsed.modelVersion || model,
      tokensIn: parsed.usageMetadata?.promptTokenCount,
      tokensOut: parsed.usageMetadata?.candidatesTokenCount,
    };
  },

  async discoverModels(apiKey: string): Promise<DiscoveryResult<VisionModelInfo>> {
    try {
      const res = await fetch(`${GOOGLE_BASE_URL}/models?key=${encodeURIComponent(apiKey)}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`google list-models ${res.status}: ${body.slice(0, 300)}`);
      }
      const parsed = (await res.json()) as GeminiListModelsResponse;
      const ids = new Set<string>();
      for (const m of parsed.models ?? []) {
        const id = m.name.replace(/^models\//, '');
        if (m.supportedGenerationMethods?.includes('generateContent')) {
          ids.add(id);
        }
      }
      return {
        available: GOOGLE_VISION_MODELS.filter((m) => ids.has(m.id)),
        filtered: true,
        error: null,
      };
    } catch (err) {
      return {
        available: [...GOOGLE_VISION_MODELS],
        filtered: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  staticCatalog() {
    return GOOGLE_VISION_MODELS;
  },
};
