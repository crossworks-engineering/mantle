/**
 * OpenRouter embedding adapter. Wraps OR's `/api/v1/embeddings` endpoint
 * — the same endpoint `@mantle/embeddings` has called directly since the
 * package was created. The logic that used to live in
 * `packages/embeddings/src/client.ts` moves here so every embedding
 * provider goes through the same dispatcher interface.
 *
 * OR is the richest embedding source: ~25 models with pricing,
 * keyless catalog discovery via `/api/v1/embeddings/models`, and the
 * only path that supports multimodal embedding (gemini-embedding-2-preview,
 * nvidia/llama-nemotron-embed-vl). Other adapters are text-only.
 */

import type {
  EmbedInput,
  EmbedRequest,
  EmbedResult,
  EmbeddingDispatcher,
  EmbeddingModelInfo,
} from './types';
import type { DiscoveryResult } from '../discover';

const ENDPOINT = 'https://openrouter.ai/api/v1/embeddings';
const CATALOG_URL = 'https://openrouter.ai/api/v1/embeddings/models';

/** Models that accept non-text inputs. Add as new ones land on OpenRouter.
 *  Kept synced with @mantle/embeddings#MULTIMODAL_MODELS — single source of
 *  truth would be nicer but the package boundary prevents a cycle (voice
 *  already imports nothing from embeddings; flipping that would loop). */
const MULTIMODAL_MODELS = new Set<string>([
  'google/gemini-embedding-2-preview',
  'nvidia/llama-nemotron-embed-vl-1b-v2',
  'nvidia/llama-nemotron-embed-vl-1b-v2:free',
]);

function isMultimodalModel(model: string): boolean {
  return MULTIMODAL_MODELS.has(model.toLowerCase());
}

/** Translate one EmbedInput into OR's request-element shape. Strings and
 *  `{type:'text'}` become plain strings; binary types become the
 *  provider-specific `{image_url,...}` etc. shape. */
function toRawElement(item: EmbedInput): string | Record<string, unknown> {
  if (typeof item === 'string') return item;
  switch (item.type) {
    case 'text':
      return item.text;
    case 'image':
      return { image_url: { url: item.url } };
    case 'audio':
      return { audio_url: { url: item.url } };
    case 'file':
      return {
        file_url: {
          url: item.url,
          ...(item.mimeType ? { mime_type: item.mimeType } : {}),
        },
      };
  }
}

export const openrouterEmbedding: EmbeddingDispatcher = {
  providerId: 'openrouter',
  adapterName: 'openrouter-embedding',

  async embed(req: EmbedRequest): Promise<EmbedResult> {
    // OR's API accepts string[] OR object[] uniformly. If every input is
    // plain text, send the simpler string[] form (some upstream providers
    // reject the rich-object shape even when OR proxies them).
    const allText = req.input.every(
      (i) => typeof i === 'string' || (typeof i === 'object' && i.type === 'text'),
    );
    const rawInput = allText
      ? req.input.map((i) => (typeof i === 'string' ? i : (i as { type: 'text'; text: string }).text))
      : req.input.map(toRawElement);

    const body: Record<string, unknown> = {
      model: req.model,
      input: rawInput,
    };
    if (req.dimensions && isMultimodalModel(req.model)) {
      body.output_dimensionality = req.dimensions;
    }

    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${req.apiKey}`,
        'content-type': 'application/json',
        'http-referer': 'https://mantle.crossworks.network',
        'x-title': 'Mantle',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `OpenRouter embeddings failed: ${res.status} ${res.statusText} — ${text.slice(0, 500)}`,
      );
    }
    const json = (await res.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
      model?: string;
      usage?: { prompt_tokens?: number; total_tokens?: number };
    };
    if (!Array.isArray(json.data)) {
      throw new Error('OpenRouter embeddings: malformed response (no data array)');
    }
    // Sort by index — defensive even though OR returns ordered.
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    return {
      vectors: sorted.map((d) => d.embedding),
      model: json.model ?? req.model,
      tokensIn: json.usage?.prompt_tokens,
    };
  },

  acceptsInput(_input: EmbedInput): boolean {
    // OR delegates to whatever upstream the model id routes to. Text
    // works against everything; multimodal works only against the
    // models in MULTIMODAL_MODELS. The adapter can't know which model
    // the caller will pick — accept everything here and let the
    // request fail loudly if the upstream rejects it.
    return true;
  },

  async discoverModels(_apiKey: string): Promise<DiscoveryResult<EmbeddingModelInfo>> {
    // Keyless catalog — OR publishes /v1/embeddings/models separately
    // from the main /v1/models. Same response shape as the chat catalog
    // (id, name, context_length, pricing, architecture). The _apiKey
    // argument is unused but kept to match the dispatcher interface.
    const res = await fetch(CATALOG_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      return {
        available: [],
        filtered: false,
        error: `openrouter /v1/embeddings/models: HTTP ${res.status}`,
      };
    }
    const body = (await res.json()) as {
      data?: Array<{
        id?: string;
        name?: string;
        description?: string;
        context_length?: number | null;
        pricing?: { prompt?: string | null } | null;
      }>;
    };
    const available: EmbeddingModelInfo[] = (body.data ?? [])
      .filter((m): m is { id: string } & typeof m => typeof m.id === 'string' && m.id.length > 0)
      .map((m) => {
        const raw = m.pricing?.prompt;
        const perToken = typeof raw === 'string' && raw.length > 0 ? Number(raw) : undefined;
        const inputPricePer1M = Number.isFinite(perToken)
          ? (perToken as number) * 1_000_000
          : undefined;
        return {
          id: m.id,
          label: m.name ?? m.id,
          description: m.description ?? '',
          contextTokens: typeof m.context_length === 'number' ? m.context_length : undefined,
          inputPricePer1M,
          multimodal: isMultimodalModel(m.id),
        };
      });
    return { available, filtered: false, error: null };
  },
};
