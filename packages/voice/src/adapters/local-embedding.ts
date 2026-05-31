/**
 * Local OpenAI-compatible embedding adapter. Points at a self-hosted embedding
 * server — Ollama, LM Studio, llama.cpp, TEI, or vLLM — that exposes the OpenAI
 * `/v1/embeddings` API, so the embedded text never leaves your own hardware.
 * This is the privacy path: the document content the brain embeds (emails,
 * files, notes) is processed on a machine you control, not a cloud API.
 *
 * Base URL comes from `MANTLE_LOCAL_EMBEDDING_URL` (default
 * `http://localhost:11434/v1`, Ollama's default) — so the same adapter serves
 * a localhost embedder in dev and a LAN/Tailscale box in prod, by config alone.
 *
 * The `model` id must match what your server reports in `/v1/models` (e.g.
 * Ollama: `embeddinggemma`; LM Studio: `text-embedding-embeddinggemma-300m`).
 * Text-only. No API key is required — the Bearer header is sent for OpenAI-API
 * conformance but local servers ignore it.
 */

import type {
  EmbedInput,
  EmbedRequest,
  EmbedResult,
  EmbeddingDispatcher,
  EmbeddingModelInfo,
} from './types';
import type { DiscoveryResult } from '../discover';

const DEFAULT_BASE_URL = 'http://localhost:11434/v1';

/** Resolved per-call so a config/env change takes effect without a restart.
 *  Precedence: the embedding config's per-route `baseUrl` (so primary and
 *  backup can target different hosts) → the `MANTLE_LOCAL_EMBEDDING_URL` env
 *  → the Ollama default. */
function baseUrl(override?: string): string {
  return (override || process.env.MANTLE_LOCAL_EMBEDDING_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function assertTextOnly(input: EmbedInput[]): void {
  for (const item of input) {
    if (typeof item === 'string') continue;
    if (item.type === 'text') continue;
    throw new Error(
      `local-embedding: input type '${item.type}' is not supported — local embedders are text-only here. Route multimodal inputs to a multimodal provider.`,
    );
  }
}

function toPlainText(item: EmbedInput): string {
  if (typeof item === 'string') return item;
  if (item.type === 'text') return item.text;
  throw new Error(`local-embedding: non-text input slipped past the guard (${item.type})`);
}

export const localEmbedding: EmbeddingDispatcher = {
  providerId: 'local',
  adapterName: 'local-embedding',

  async embed(req: EmbedRequest): Promise<EmbedResult> {
    assertTextOnly(req.input);
    const body: Record<string, unknown> = {
      model: req.model,
      input: req.input.map(toPlainText),
      encoding_format: 'float',
    };
    // Matryoshka truncation where the server honours it (EmbeddingGemma,
    // jina-v5, etc.). Harmless when ignored; the resulting dim is what
    // actually lands in the column, so the caller must size accordingly.
    if (req.dimensions) body.dimensions = req.dimensions;

    const res = await fetch(`${baseUrl(req.baseUrl)}/embeddings`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${req.apiKey || 'local'}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `local embeddings failed: ${res.status} ${res.statusText} — ${text.slice(0, 500)}`,
      );
    }
    const json = (await res.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
      model?: string;
      usage?: { prompt_tokens?: number; total_tokens?: number };
    };
    if (!Array.isArray(json.data)) {
      throw new Error('local embeddings: malformed response (no data array)');
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

  async discoverModels(_apiKey: string): Promise<DiscoveryResult<EmbeddingModelInfo>> {
    // Whatever the local server is currently serving. `/v1/models` doesn't
    // report dimensions, so the form's Test button verifies the live dim
    // (which is the only number that matters for the column).
    try {
      const res = await fetch(`${baseUrl()}/models`, { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) {
        return { available: [], filtered: false, error: `local /v1/models: HTTP ${res.status}` };
      }
      const body = (await res.json()) as { data?: Array<{ id?: string }> };
      const available: EmbeddingModelInfo[] = (body.data ?? [])
        .filter((m): m is { id: string } => typeof m.id === 'string')
        .map((m) => ({
          id: m.id,
          label: m.id,
          description: 'Local model reported by your server — verify dimensions with Test.',
        }));
      return { available, filtered: false, error: null };
    } catch (e) {
      return { available: [], filtered: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
};
