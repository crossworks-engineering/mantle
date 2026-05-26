/**
 * OpenAI direct embedding adapter. Calls `api.openai.com/v1/embeddings`
 * with the user's OpenAI key (not the OpenRouter routed slug). Skips
 * OR's ~5% margin for high-volume embedding workloads.
 *
 * Coverage: text-embedding-3-small (1536), text-embedding-3-large (3072
 * — note the dim mismatch with Mantle's vector(1536) column; the form's
 * dim-safety block catches it), text-embedding-ada-002 (1536, legacy).
 * Text-only — OpenAI doesn't ship multimodal embedding.
 */

import type {
  EmbedInput,
  EmbedRequest,
  EmbedResult,
  EmbeddingDispatcher,
  EmbeddingModelInfo,
} from './types';
import type { DiscoveryResult } from '../discover';

const ENDPOINT = 'https://api.openai.com/v1/embeddings';
const MODELS_URL = 'https://api.openai.com/v1/models';

/** Hand-curated catalog — OpenAI's /v1/models doesn't tag embeddings
 *  separately, so we keep a short allow-list for the form to show even
 *  when discovery hasn't run. Pricing as of 2025 — verify on the
 *  pricing page when in doubt. */
const STATIC_CATALOG: readonly EmbeddingModelInfo[] = [
  {
    id: 'text-embedding-3-small',
    label: 'text-embedding-3-small',
    description: '1536-dim, the brain default. Cheapest OpenAI embedding.',
    contextTokens: 8191,
    dimensions: 1536,
    inputPricePer1M: 0.02,
  },
  {
    id: 'text-embedding-3-large',
    label: 'text-embedding-3-large',
    description:
      '3072-dim native — NOT compatible with the brain\'s vector(1536) column. Higher recall but needs the `dimensions` param truncating to 1536 to fit, or a schema migration.',
    contextTokens: 8191,
    dimensions: 3072,
    inputPricePer1M: 0.13,
  },
  {
    id: 'text-embedding-ada-002',
    label: 'text-embedding-ada-002',
    description: '1536-dim, legacy. Kept for parity with vectors embedded before 3-small shipped.',
    contextTokens: 8191,
    dimensions: 1536,
    inputPricePer1M: 0.1,
  },
];

function assertTextOnly(input: EmbedInput[]): void {
  for (const item of input) {
    if (typeof item === 'string') continue;
    if (item.type === 'text') continue;
    throw new Error(
      `openai-embedding: input type '${item.type}' requires a multimodal model — OpenAI's embedding endpoint is text-only. Use the OpenRouter provider with a multimodal model (e.g. google/gemini-embedding-2-preview) for image/audio/file inputs.`,
    );
  }
}

function toPlainText(item: EmbedInput): string {
  if (typeof item === 'string') return item;
  if (item.type === 'text') return item.text;
  // Unreachable given the assertTextOnly guard above, but the type
  // narrowing requires the explicit throw.
  throw new Error(`openai-embedding: non-text input slipped past the guard (${item.type})`);
}

export const openaiEmbedding: EmbeddingDispatcher = {
  providerId: 'openai',
  adapterName: 'openai-embedding',

  async embed(req: EmbedRequest): Promise<EmbedResult> {
    assertTextOnly(req.input);
    const body: Record<string, unknown> = {
      model: req.model,
      input: req.input.map(toPlainText),
      encoding_format: 'float',
    };
    // OpenAI's text-embedding-3-* family honours `dimensions` (MRL
    // truncation). ada-002 ignores it. Sending it harmlessly when the
    // model accepts it; OpenAI errors when the dim is invalid for the
    // model, which the form's Test button will catch.
    if (req.dimensions) body.dimensions = req.dimensions;

    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${req.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `OpenAI embeddings failed: ${res.status} ${res.statusText} — ${text.slice(0, 500)}`,
      );
    }
    const json = (await res.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
      model?: string;
      usage?: { prompt_tokens?: number; total_tokens?: number };
    };
    if (!Array.isArray(json.data)) {
      throw new Error('OpenAI embeddings: malformed response (no data array)');
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
    // OpenAI's /v1/models returns chat + embedding + audio + image
    // models mixed together with no kind tag. We pattern-match
    // `text-embedding-*` ids and cross-reference against the static
    // catalog for pricing/dimensions metadata. Anything matching the
    // prefix but missing from STATIC_CATALOG still surfaces — the
    // form's Test button verifies dim live, so unknown models are
    // safe to expose.
    try {
      const res = await fetch(MODELS_URL, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) {
        return {
          available: [...STATIC_CATALOG],
          filtered: false,
          error: `openai /v1/models: HTTP ${res.status}`,
        };
      }
      const body = (await res.json()) as { data?: Array<{ id?: string }> };
      const byId = new Map(STATIC_CATALOG.map((m) => [m.id, m]));
      const available: EmbeddingModelInfo[] = (body.data ?? [])
        .filter((m): m is { id: string } => typeof m.id === 'string' && /embedding/i.test(m.id))
        .map((m) => {
          const known = byId.get(m.id);
          return (
            known ?? {
              id: m.id,
              label: m.id,
              description: 'Embedding model returned by /v1/models — verify dimensions with the Test button.',
            }
          );
        });
      // Sort known models first (they have rich metadata), unknowns
      // after — keeps the picker scannable.
      available.sort((a, b) => {
        const aKnown = byId.has(a.id) ? 0 : 1;
        const bKnown = byId.has(b.id) ? 0 : 1;
        return aKnown - bKnown || a.id.localeCompare(b.id);
      });
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
