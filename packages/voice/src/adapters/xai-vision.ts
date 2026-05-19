/**
 * xAI (Grok) vision adapter.
 *
 * xAI's chat-completions endpoint is OpenAI-compatible, so the vision
 * shape is identical: messages[].content as an array of text +
 * image_url parts.
 *
 * Endpoint: POST {XAI_BASE_URL}/chat/completions
 * Auth:     Bearer
 * Shape:    Identical to openai-vision (chat-completions with
 *           `{type: 'image_url', image_url: {url: 'data:...'}}` parts).
 *
 * MIMEs accepted: jpeg, png, webp. (No gif at the xAI API as of
 * May 2026 — they reject animated formats.)
 *
 * Discovery hits /v1/models like xai-chat does; if it fails we fall
 * back to the static vision catalog.
 */

import type {
  VisionDispatcher,
  VisionExtractOptions,
  VisionExtractResult,
  VisionModelInfo,
} from './types';
import type { DiscoveryResult } from '../discover';
import { XAI_BASE_URL, XAI_VISION_MODELS } from '../catalogs/xai';

const DEFAULT_MODEL = 'grok-4.3';
const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

type XaiChatResponse = {
  model?: string;
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

type XaiListModelsResponse = {
  data?: Array<{ id: string }>;
};

export const xaiVisionAdapter: VisionDispatcher = {
  providerId: 'xai',
  adapterName: 'xai-vision',
  async extract(image: Buffer, opts: VisionExtractOptions): Promise<VisionExtractResult> {
    if (!opts.apiKey) throw new Error('xai-vision: apiKey required');
    if (!image || image.length === 0) throw new Error('xai-vision: empty image buffer');
    if (!ALLOWED_MIMES.has(opts.mimeType)) {
      throw new Error(
        `xai-vision: unsupported mime '${opts.mimeType}'. xAI accepts jpeg/png/webp.`,
      );
    }
    const model = opts.model || DEFAULT_MODEL;
    const dataUrl = `data:${opts.mimeType};base64,${image.toString('base64')}`;

    const messages: Array<Record<string, unknown>> = [];
    if (opts.systemPrompt && opts.systemPrompt.trim()) {
      messages.push({ role: 'system', content: opts.systemPrompt });
    }
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: opts.prompt },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    });

    const body = {
      model,
      messages,
      max_tokens: opts.maxTokens ?? 2000,
    };

    const res = await fetch(`${XAI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`xai-vision ${res.status}: ${errBody.slice(0, 400)}`);
    }
    const parsed = (await res.json()) as XaiChatResponse;
    const text = (parsed.choices?.[0]?.message?.content ?? '').trim();
    return {
      text,
      model: parsed.model || model,
      tokensIn: parsed.usage?.prompt_tokens,
      tokensOut: parsed.usage?.completion_tokens,
    };
  },

  async discoverModels(apiKey: string): Promise<DiscoveryResult<VisionModelInfo>> {
    try {
      const res = await fetch(`${XAI_BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`xai list-models ${res.status}: ${body.slice(0, 300)}`);
      }
      const parsed = (await res.json()) as XaiListModelsResponse;
      const ids = new Set((parsed.data ?? []).map((m) => m.id));
      const available = XAI_VISION_MODELS.filter((m) => ids.has(m.id));
      return {
        available: available.length > 0 ? available : [...XAI_VISION_MODELS],
        filtered: available.length > 0,
        error: null,
      };
    } catch (err) {
      return {
        available: [...XAI_VISION_MODELS],
        filtered: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  staticCatalog() {
    return XAI_VISION_MODELS;
  },
};
