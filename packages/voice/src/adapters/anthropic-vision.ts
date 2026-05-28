/**
 * Anthropic (Claude) vision adapter.
 *
 * Endpoint: POST https://api.anthropic.com/v1/messages
 * Auth:     `x-api-key` + `anthropic-version: 2023-06-01` headers
 * Shape:    Messages array where the user turn's `content` is an
 *           array containing an image block and a text block:
 *             [
 *               {
 *                 type: 'image',
 *                 source: { type: 'base64', media_type: 'image/jpeg', data: '...' }
 *               },
 *               { type: 'text', text: <prompt> },
 *             ]
 *           System prompt lives in the top-level `system` field, same
 *           as anthropic-chat.
 *
 * Image limits (May 2026):
 *   - max 5MB per image at the API layer
 *   - resized internally to fit ~1.6 megapixels
 *   - accepted MIMEs: jpeg, png, gif, webp
 *
 * We don't pre-resize — Anthropic does it server-side. If the image
 * is >5MB we error rather than silently failing on the API call.
 */

import type {
  VisionDispatcher,
  VisionExtractOptions,
  VisionExtractResult,
  VisionModelInfo,
} from './types';
import type { DiscoveryResult } from '../discover';
import {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_BASE_URL,
  ANTHROPIC_VISION_MODELS,
} from '../catalogs/anthropic';

const DEFAULT_MODEL = 'claude-haiku-4-5';
const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

type AnthropicResponse = {
  model?: string;
  content: Array<{ type: 'text'; text: string } | { type: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
};

type AnthropicListModelsResponse = {
  data?: Array<{ id: string }>;
};

export const anthropicVisionAdapter: VisionDispatcher = {
  providerId: 'anthropic',
  adapterName: 'anthropic-vision',
  async extract(image: Buffer, opts: VisionExtractOptions): Promise<VisionExtractResult> {
    if (!opts.apiKey) throw new Error('anthropic-vision: apiKey required');
    if (!image || image.length === 0) throw new Error('anthropic-vision: empty image buffer');
    if (!ALLOWED_MIMES.has(opts.mimeType)) {
      throw new Error(
        `anthropic-vision: unsupported mime '${opts.mimeType}'. Anthropic accepts jpeg/png/gif/webp.`,
      );
    }
    if (image.length > MAX_IMAGE_BYTES) {
      throw new Error(
        `anthropic-vision: image is ${(image.length / 1024 / 1024).toFixed(1)} MB; Anthropic caps at 5 MB. ` +
          `Resize or switch to OpenAI/Google for larger images.`,
      );
    }
    const model = opts.model || DEFAULT_MODEL;

    const body: Record<string, unknown> = {
      model,
      max_tokens: opts.maxTokens ?? 2000,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: opts.mimeType,
                data: image.toString('base64'),
              },
            },
            { type: 'text', text: opts.prompt },
          ],
        },
      ],
    };
    if (opts.systemPrompt && opts.systemPrompt.trim()) {
      body.system = opts.systemPrompt;
    }

    const res = await fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': opts.apiKey,
        'anthropic-version': ANTHROPIC_API_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`anthropic-vision ${res.status}: ${errBody.slice(0, 400)}`);
    }
    const parsed = (await res.json()) as AnthropicResponse;
    const textBlock = parsed.content.find(
      (c): c is { type: 'text'; text: string } => c.type === 'text',
    );
    return {
      text: (textBlock?.text ?? '').trim(),
      model: parsed.model || model,
      tokensIn: parsed.usage?.input_tokens,
      tokensOut: parsed.usage?.output_tokens,
    };
  },

  /**
   * Native PDF extraction — send the whole PDF as a `document` content block
   * (no rasterization). Claude reads the text layer AND the rendered pages, so
   * it works on scanned/image PDFs too, with whole-document context. Limits
   * (May 2026): 32 MB, 100 pages per request.
   */
  async extractDocument(pdf: Buffer, opts: VisionExtractOptions): Promise<VisionExtractResult> {
    if (!opts.apiKey) throw new Error('anthropic-vision: apiKey required');
    if (!pdf || pdf.length === 0) throw new Error('anthropic-vision: empty PDF buffer');
    const MAX_PDF_BYTES = 32 * 1024 * 1024;
    if (pdf.length > MAX_PDF_BYTES) {
      throw new Error(
        `anthropic-vision: PDF is ${(pdf.length / 1024 / 1024).toFixed(1)} MB; Anthropic caps at 32 MB.`,
      );
    }
    const model = opts.model || DEFAULT_MODEL;
    const body: Record<string, unknown> = {
      model,
      // Documents transcribe in one call (vs per-page), so allow more output.
      max_tokens: opts.maxTokens ?? 8000,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: pdf.toString('base64'),
              },
            },
            { type: 'text', text: opts.prompt },
          ],
        },
      ],
    };
    if (opts.systemPrompt && opts.systemPrompt.trim()) body.system = opts.systemPrompt;

    const res = await fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': opts.apiKey,
        'anthropic-version': ANTHROPIC_API_VERSION,
        // PDF support flag — harmless if the account already has it GA.
        'anthropic-beta': 'pdfs-2024-09-25',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      // PDFs are heavier than a single image — give the call more headroom.
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`anthropic-vision (pdf) ${res.status}: ${errBody.slice(0, 400)}`);
    }
    const parsed = (await res.json()) as AnthropicResponse;
    const textBlock = parsed.content.find(
      (c): c is { type: 'text'; text: string } => c.type === 'text',
    );
    return {
      text: (textBlock?.text ?? '').trim(),
      model: parsed.model || model,
      tokensIn: parsed.usage?.input_tokens,
      tokensOut: parsed.usage?.output_tokens,
    };
  },

  async discoverModels(apiKey: string): Promise<DiscoveryResult<VisionModelInfo>> {
    try {
      const res = await fetch(`${ANTHROPIC_BASE_URL}/v1/models?limit=100`, {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_API_VERSION,
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`anthropic list-models ${res.status}: ${body.slice(0, 300)}`);
      }
      const parsed = (await res.json()) as AnthropicListModelsResponse;
      const ids = new Set((parsed.data ?? []).map((m) => m.id));
      // Match exact ids OR dated variants (claude-haiku-4-5 ↔ claude-haiku-4-5-20251001).
      const available = ANTHROPIC_VISION_MODELS.filter(
        (m) => ids.has(m.id) || [...ids].some((live) => live.startsWith(`${m.id}-`)),
      );
      return {
        available: available.length > 0 ? available : [...ANTHROPIC_VISION_MODELS],
        filtered: available.length > 0,
        error: null,
      };
    } catch (err) {
      return {
        available: [...ANTHROPIC_VISION_MODELS],
        filtered: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  staticCatalog() {
    return ANTHROPIC_VISION_MODELS;
  },
};
