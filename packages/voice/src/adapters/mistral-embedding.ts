/**
 * Mistral embedding adapter. Calls `api.mistral.ai/v1/embeddings` — the
 * endpoint is intentionally OpenAI-compatible (Mistral ships an
 * OpenAI-shaped SDK on top), so the adapter is essentially identical
 * to openai-embedding with a different base URL + slightly narrower
 * model catalog.
 *
 * One model today: `mistral-embed` (1024-dim native — note, NOT 768, so
 * doesn't fit Mantle's vector(768) column without a schema migration).
 * Listed here for completeness and direct-routing parity; the form's
 * dim-safety block will catch the mismatch at save time.
 */

import type {
  EmbedInput,
  EmbedRequest,
  EmbedResult,
  EmbeddingDispatcher,
  EmbeddingModelInfo,
} from './types';
import type { DiscoveryResult } from '../discover';

const ENDPOINT = 'https://api.mistral.ai/v1/embeddings';
const MODELS_URL = 'https://api.mistral.ai/v1/models';

const STATIC_CATALOG: readonly EmbeddingModelInfo[] = [
  {
    id: 'mistral-embed',
    label: 'mistral-embed',
    description:
      "1024-dim native — does NOT fit the brain's vector(768) column. Solid multilingual recall; pair with a schema migration if you want to use it.",
    contextTokens: 8192,
    dimensions: 1024,
    inputPricePer1M: 0.1,
  },
];

function assertTextOnly(input: EmbedInput[]): void {
  for (const item of input) {
    if (typeof item === 'string') continue;
    if (item.type === 'text') continue;
    throw new Error(
      `mistral-embedding: input type '${item.type}' requires a multimodal model — Mistral's embedding endpoint is text-only.`,
    );
  }
}

function toPlainText(item: EmbedInput): string {
  if (typeof item === 'string') return item;
  if (item.type === 'text') return item.text;
  throw new Error(`mistral-embedding: non-text input slipped past the guard (${item.type})`);
}

export const mistralEmbedding: EmbeddingDispatcher = {
  providerId: 'mistral',
  adapterName: 'mistral-embedding',

  async embed(req: EmbedRequest): Promise<EmbedResult> {
    assertTextOnly(req.input);
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${req.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: req.model,
        input: req.input.map(toPlainText),
        encoding_format: 'float',
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `Mistral embeddings failed: ${res.status} ${res.statusText} — ${text.slice(0, 500)}`,
      );
    }
    const json = (await res.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
      model?: string;
      usage?: { prompt_tokens?: number };
    };
    if (!Array.isArray(json.data)) {
      throw new Error('Mistral embeddings: malformed response (no data array)');
    }
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    return {
      vectors: sorted.map((d) => d.embedding),
      model: json.model ?? req.model,
      tokensIn: json.usage?.prompt_tokens,
    };
  },

  acceptsInput(input: EmbedInput): boolean {
    return typeof input === 'string' || input.type === 'text';
  },

  staticCatalog(): readonly EmbeddingModelInfo[] {
    return STATIC_CATALOG;
  },

  async discoverModels(apiKey: string): Promise<DiscoveryResult<EmbeddingModelInfo>> {
    try {
      const res = await fetch(MODELS_URL, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) {
        return {
          available: [...STATIC_CATALOG],
          filtered: false,
          error: `mistral /v1/models: HTTP ${res.status}`,
        };
      }
      const body = (await res.json()) as { data?: Array<{ id?: string }> };
      const byId = new Map(STATIC_CATALOG.map((m) => [m.id, m]));
      const available: EmbeddingModelInfo[] = (body.data ?? [])
        .filter((m): m is { id: string } => typeof m.id === 'string' && /embed/i.test(m.id))
        .map(
          (m) =>
            byId.get(m.id) ?? {
              id: m.id,
              label: m.id,
              description: 'Embedding model returned by /v1/models — verify dimensions with Test.',
            },
        );
      return { available, filtered: true, error: null };
    } catch (err) {
      return {
        available: [...STATIC_CATALOG],
        filtered: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};
