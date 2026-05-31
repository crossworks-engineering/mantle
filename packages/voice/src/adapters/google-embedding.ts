/**
 * Google Gemini embedding adapter. Calls
 * `generativelanguage.googleapis.com/v1beta/models/{model}:batchEmbedContents`
 * with the user's Google AI Studio key.
 *
 * Distinct from the other embedding adapters in shape:
 *   - Model id sits in the URL path, not the request body.
 *   - API key is a query string (`?key=...`), not a header.
 *   - Per-input requests have to be wrapped in `requests: [...]` for
 *     batch — single-input calls go to `:embedContent` instead.
 *   - Honours `outputDimensionality` for the new gemini-embedding line
 *     (truncates via MRL).
 *
 * Text-only at the API endpoint level (no image/audio/file). Google's
 * gemini-embedding-2-preview IS multimodal but only when routed through
 * OpenRouter where they unify the API shape; the direct API is text-only.
 */

import type {
  EmbedInput,
  EmbedRequest,
  EmbedResult,
  EmbeddingDispatcher,
  EmbeddingModelInfo,
} from './types';
import type { DiscoveryResult } from '../discover';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** Hand-curated catalog of Google's embedding models. Their `/v1beta/models`
 *  endpoint requires filtering by `supportedGenerationMethods` containing
 *  `embedContent` — we do that filter in discoverModels below. */
const STATIC_CATALOG: readonly EmbeddingModelInfo[] = [
  {
    id: 'models/text-embedding-004',
    label: 'text-embedding-004',
    description:
      '768-dim native — fits the brain\'s vector(768) column exactly (migration 0060). A cloud alternative to the local EmbeddingGemma default if you want Google retrieval.',
    contextTokens: 2048,
    dimensions: 768,
    inputPricePer1M: 0,
  },
  {
    id: 'models/gemini-embedding-001',
    label: 'gemini-embedding-001',
    description:
      '3072-dim native but supports `outputDimensionality` (MRL) to truncate down to 768 — set the worker\'s output_dimensions param. Strong English + multilingual recall.',
    contextTokens: 2048,
    dimensions: 3072,
    inputPricePer1M: 0.15,
  },
];

function assertTextOnly(input: EmbedInput[]): void {
  for (const item of input) {
    if (typeof item === 'string') continue;
    if (item.type === 'text') continue;
    throw new Error(
      `google-embedding: input type '${item.type}' requires a multimodal model — Google's direct /v1beta embedContent endpoint is text-only. Use the OpenRouter provider with google/gemini-embedding-2-preview for multimodal embedding.`,
    );
  }
}

function toPlainText(item: EmbedInput): string {
  if (typeof item === 'string') return item;
  if (item.type === 'text') return item.text;
  throw new Error(`google-embedding: non-text input slipped past the guard (${item.type})`);
}

/** Google requires the model id to include the `models/` prefix in the
 *  URL path. Accept either form from callers; normalise to the prefixed
 *  form before constructing the URL. */
function normaliseModelId(raw: string): string {
  return raw.startsWith('models/') ? raw : `models/${raw}`;
}

export const googleEmbedding: EmbeddingDispatcher = {
  providerId: 'google',
  adapterName: 'google-embedding',

  async embed(req: EmbedRequest): Promise<EmbedResult> {
    assertTextOnly(req.input);
    const modelPath = normaliseModelId(req.model);
    const url = `${BASE}/${modelPath}:batchEmbedContents?key=${encodeURIComponent(req.apiKey)}`;

    const body: Record<string, unknown> = {
      requests: req.input.map((item) => {
        const text = toPlainText(item);
        const r: Record<string, unknown> = {
          // Each entry's `model` field must match the URL path — Google's
          // batch endpoint validates this. Send the full prefixed id.
          model: modelPath,
          content: { parts: [{ text }] },
        };
        if (req.dimensions) r.outputDimensionality = req.dimensions;
        return r;
      }),
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `Google embeddings failed: ${res.status} ${res.statusText} — ${text.slice(0, 500)}`,
      );
    }
    const json = (await res.json()) as {
      embeddings?: Array<{ values: number[] }>;
    };
    if (!Array.isArray(json.embeddings)) {
      throw new Error('Google embeddings: malformed response (no embeddings array)');
    }
    return {
      vectors: json.embeddings.map((e) => e.values),
      model: modelPath,
      // Google doesn't report token usage on this endpoint.
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
      const res = await fetch(
        `${BASE}/models?key=${encodeURIComponent(apiKey)}`,
        { signal: AbortSignal.timeout(8_000), headers: { accept: 'application/json' } },
      );
      if (!res.ok) {
        return {
          available: [...STATIC_CATALOG],
          filtered: false,
          error: `google /v1beta/models: HTTP ${res.status}`,
        };
      }
      const body = (await res.json()) as {
        models?: Array<{
          name?: string;
          displayName?: string;
          description?: string;
          inputTokenLimit?: number;
          supportedGenerationMethods?: string[];
        }>;
      };
      const byId = new Map(STATIC_CATALOG.map((m) => [m.id, m]));
      const available: EmbeddingModelInfo[] = (body.models ?? [])
        .filter(
          (m): m is { name: string } & typeof m =>
            typeof m.name === 'string' &&
            Array.isArray(m.supportedGenerationMethods) &&
            m.supportedGenerationMethods.includes('embedContent'),
        )
        .map((m) => {
          const known = byId.get(m.name);
          return (
            known ?? {
              id: m.name,
              label: m.displayName ?? m.name,
              description: m.description ?? '',
              contextTokens: m.inputTokenLimit,
            }
          );
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
