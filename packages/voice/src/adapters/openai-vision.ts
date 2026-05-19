/**
 * OpenAI vision adapter — image → text via chat completions.
 *
 * Endpoint: POST https://api.openai.com/v1/chat/completions
 * Auth:     Bearer
 * Shape:    Standard chat-completions, but the user message's content
 *           is an array containing text + image parts:
 *             [
 *               { type: 'text', text: <prompt> },
 *               { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,...' } },
 *             ]
 *
 * Image encoding: data URL with the image's actual mime type. OpenAI
 * accepts jpeg, png, webp, gif. We reject other mimes upfront rather
 * than letting the API 400.
 *
 * Discovery: GET /v1/models cross-referenced against our catalog of
 * vision-capable model ids. Same call OpenAI TTS/STT discovery uses.
 *
 * Cost note: vision input is billed at the model's standard input
 * rate, but a 1024x1024 image counts as ~750 tokens on gpt-4o-mini
 * (and detail='high' goes higher). Operators can keep cost bounded
 * by maxTokens on the output side.
 */

import type {
  VisionDispatcher,
  VisionExtractOptions,
  VisionExtractResult,
  VisionModelInfo,
} from './types';
import type { DiscoveryResult } from '../discover';
import { OPENAI_VISION_MODELS } from '../catalogs/openai-vision';

const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';
const DEFAULT_MODEL = 'gpt-4o-mini';
const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

type OpenAiChatResponse = {
  model?: string;
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

export const openAiVisionAdapter: VisionDispatcher = {
  providerId: 'openai',
  adapterName: 'openai-vision',
  async extract(image: Buffer, opts: VisionExtractOptions): Promise<VisionExtractResult> {
    if (!opts.apiKey) throw new Error('openai-vision: apiKey required');
    if (!image || image.length === 0) throw new Error('openai-vision: empty image buffer');
    if (!ALLOWED_MIMES.has(opts.mimeType)) {
      throw new Error(
        `openai-vision: unsupported mime '${opts.mimeType}'. OpenAI accepts jpeg/png/webp/gif.`,
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
        // detail='auto' lets OpenAI pick low/high based on image size.
        // For most note photos auto = high, which is what we want; for
        // tiny thumbnails it picks low and saves tokens.
        { type: 'image_url', image_url: { url: dataUrl, detail: 'auto' } },
      ],
    });

    const body = {
      model,
      messages,
      max_tokens: opts.maxTokens ?? 2000,
    };

    const res = await fetch(OPENAI_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      // Vision calls are usually fast but a big image with high detail
      // can take 15-20s — give a comfortable cap.
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`openai-vision ${res.status}: ${errBody.slice(0, 400)}`);
    }
    const parsed = (await res.json()) as OpenAiChatResponse;
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
      const res = await fetch(OPENAI_MODELS_URL, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`openai list-models ${res.status}: ${body.slice(0, 300)}`);
      }
      const parsed = (await res.json()) as { data?: Array<{ id: string }> };
      const ids = new Set((parsed.data ?? []).map((m) => m.id));
      return {
        available: OPENAI_VISION_MODELS.filter((m) => ids.has(m.id)),
        filtered: true,
        error: null,
      };
    } catch (err) {
      return {
        available: [...OPENAI_VISION_MODELS],
        filtered: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  staticCatalog() {
    return OPENAI_VISION_MODELS;
  },
};
