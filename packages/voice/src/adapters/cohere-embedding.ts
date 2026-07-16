/**
 * Cohere embedding adapter. Calls `api.cohere.com/v2/embed`.
 *
 * Cohere's API shape is meaningfully different from OpenAI-compatible:
 *   - Request key is `texts` (array), not `input`.
 *   - Required `input_type` field tags the use case
 *     (`search_document` for the corpus side, `search_query` for the
 *     query side). Cohere asymmetrically optimises retrieval — using
 *     the wrong type at the wrong end degrades recall noticeably.
 *     The adapter defaults to `search_document` since the dominant
 *     use case (Mantle's extractor writes) is the corpus side. Query
 *     callers (recall, MCP search) can pass `extra.inputType` to
 *     override per-call — though plumbing that through embed() is a
 *     future enhancement; today both sides use the document type
 *     uniformly, which loses some recall but is still functional.
 *   - Response: `{ embeddings: { float: [[...]] } }` — nested by
 *     `embedding_types` (we always request `float`).
 *
 * Coverage: embed-english-v3.0 (1024-dim), embed-multilingual-v3.0
 * (1024-dim) — neither fits Mantle's vector(768) column without a
 * schema migration. The form's dim-safety block will catch it.
 */

import type {
  EmbedInput,
  EmbedRequest,
  EmbedResult,
  EmbeddingDispatcher,
  EmbeddingModelInfo,
} from './types';
import type { DiscoveryResult } from '../discover';

const ENDPOINT = 'https://api.cohere.com/v2/embed';
const MODELS_URL = 'https://api.cohere.com/v1/models';

const STATIC_CATALOG: readonly EmbeddingModelInfo[] = [
  {
    id: 'embed-english-v3.0',
    label: 'embed-english-v3.0',
    description:
      "1024-dim — does NOT fit the brain's vector(768) column. Excellent English retrieval; needs a schema migration to use as Mantle's embedding.",
    contextTokens: 512,
    dimensions: 1024,
    inputPricePer1M: 0.1,
  },
  {
    id: 'embed-multilingual-v3.0',
    label: 'embed-multilingual-v3.0',
    description: '1024-dim — same dim caveat. Strong 100+ language coverage.',
    contextTokens: 512,
    dimensions: 1024,
    inputPricePer1M: 0.1,
  },
  {
    id: 'embed-english-light-v3.0',
    label: 'embed-english-light-v3.0',
    description: '384-dim, cheap + fast — same dim caveat.',
    contextTokens: 512,
    dimensions: 384,
    inputPricePer1M: 0.1,
  },
];

function assertTextOnly(input: EmbedInput[]): void {
  for (const item of input) {
    if (typeof item === 'string') continue;
    if (item.type === 'text') continue;
    throw new Error(
      `cohere-embedding: input type '${item.type}' requires a multimodal model — Cohere's embedding endpoint is text-only.`,
    );
  }
}

function toPlainText(item: EmbedInput): string {
  if (typeof item === 'string') return item;
  if (item.type === 'text') return item.text;
  throw new Error(`cohere-embedding: non-text input slipped past the guard (${item.type})`);
}

export const cohereEmbedding: EmbeddingDispatcher = {
  providerId: 'cohere',
  adapterName: 'cohere-embedding',

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
        texts: req.input.map(toPlainText),
        // Default to 'search_document' — Mantle's dominant use case is
        // the corpus side (extractor writes). The query side would
        // ideally use 'search_query' but plumbing that distinction
        // through embed() is a future enhancement.
        input_type: 'search_document',
        embedding_types: ['float'],
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `Cohere embeddings failed: ${res.status} ${res.statusText} — ${text.slice(0, 500)}`,
      );
    }
    const json = (await res.json()) as {
      embeddings?: { float?: number[][] };
      meta?: { billed_units?: { input_tokens?: number } };
    };
    const vectors = json.embeddings?.float;
    if (!Array.isArray(vectors)) {
      throw new Error('Cohere embeddings: malformed response (no embeddings.float array)');
    }
    return {
      vectors,
      model: req.model,
      tokensIn: json.meta?.billed_units?.input_tokens,
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
          error: `cohere /v1/models: HTTP ${res.status}`,
        };
      }
      const body = (await res.json()) as {
        models?: Array<{ name?: string; endpoints?: string[] }>;
      };
      const byId = new Map(STATIC_CATALOG.map((m) => [m.id, m]));
      const available: EmbeddingModelInfo[] = (body.models ?? [])
        .filter(
          (m): m is { name: string } & typeof m =>
            typeof m.name === 'string' &&
            Array.isArray(m.endpoints) &&
            m.endpoints.includes('embed'),
        )
        .map(
          (m) =>
            byId.get(m.name) ?? {
              id: m.name,
              label: m.name,
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
