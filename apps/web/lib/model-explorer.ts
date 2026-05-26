/**
 * Live model-catalog explorer. For a chosen provider, hits that provider's
 * public "list models" API and returns BOTH a normalised view (context window,
 * pricing, modality, type) AND the verbatim raw payload — "as much as the API
 * returns" — for the /models Review page.
 *
 * Server-only: most providers need the user's stored API key (resolved via
 * @mantle/api-keys), which must never reach the client. The page + /api/models
 * route are the only callers. OpenRouter's catalog is public (keyless) and the
 * richest source (pricing + context + modality + supported params); the direct
 * providers vary from rich (Google, Mistral, Cohere) to bare id lists
 * (OpenAI, Anthropic, DeepSeek). Providers with no usable list API are reported
 * as `unsupported` rather than failing.
 *
 * Provider ids are the canonical `@mantle/voice` SUPPORTED_PROVIDERS ids, which
 * are also the `api_keys.service` strings — so the key lookup is a 1:1 match.
 */
import { getApiKey } from '@mantle/api-keys';
import { isProviderId, type ProviderId } from '@mantle/voice';

/** One model as shown in the explorer. Normalised fields are best-effort
 *  (absent when the provider's API doesn't return them); `raw` is always the
 *  untouched object the API gave us. */
export type ExplorerModel = {
  /** Provider model id / slug (e.g. 'anthropic/claude-sonnet-4.6'). */
  id: string;
  /** Friendly display name if the API provides one. */
  name?: string;
  description?: string;
  /** Total context window in tokens. */
  contextTokens?: number;
  /** Max output/completion tokens, when stated separately. */
  maxOutputTokens?: number;
  /** USD per 1M input (prompt) tokens. 0 means free; undefined means unknown. */
  inputPricePerM?: number;
  /** USD per 1M output (completion) tokens. */
  outputPricePerM?: number;
  /** Other priced dimensions the API exposes, surfaced verbatim. */
  extraPricing?: { label: string; value: string }[];
  /** e.g. 'text+image→text'. */
  modality?: string;
  /** Coarse type: chat | embedding | image | tts | stt | rerank | other. */
  kind?: string;
  /** Release/creation time as ISO, when provided. */
  created?: string;
  /** The provider's untouched model object. */
  raw: unknown;
};

export type ProviderModelsResult = {
  provider: ProviderId;
  models: ExplorerModel[];
  /** Epoch ms of this fetch. */
  fetchedAt: number;
  /** Provider needs a key and none is configured. */
  needsKey?: boolean;
  /** Provider has no usable model-list API in this explorer. */
  unsupported?: boolean;
  /** Fetch/parse error message. */
  error?: string;
};

const FETCH_TIMEOUT_MS = 12_000;

// ── small helpers ──────────────────────────────────────────────────────────

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
}
/** USD-per-token string → USD per 1M tokens. Keeps 0 (free) as 0. */
function perMillion(v: unknown): number | undefined {
  const n = num(v);
  return n === undefined ? undefined : n * 1_000_000;
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function isoFromEpochSeconds(v: unknown): string | undefined {
  const n = num(v);
  if (n === undefined || n <= 0) return undefined;
  return new Date(n * 1000).toISOString();
}
function humanize(key: string): string {
  return key.replace(/_/g, ' ');
}
/** Infer a coarse model type from its id when the API doesn't say. */
function kindFromId(id: string): string {
  const s = id.toLowerCase();
  if (s.includes('embed')) return 'embedding';
  if (s.includes('rerank')) return 'rerank';
  if (s.includes('whisper') || s.includes('transcribe') || s.includes('/stt')) return 'stt';
  if (s.includes('tts') || s.includes('speech')) return 'tts';
  if (s.includes('dall-e') || s.includes('image') || s.includes('imagen')) return 'image';
  return 'chat';
}
async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`);
  }
  return res.json();
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

// ── pure parsers (exported for unit tests) ───────────────────────────────────

/** OpenRouter `/api/v1/models` → ExplorerModel[]. The richest source. */
export function parseOpenRouter(data: unknown[]): ExplorerModel[] {
  return data.map((raw) => {
    const m = rec(raw);
    const arch = rec(m.architecture);
    const top = rec(m.top_provider);
    const pricing = rec(m.pricing);
    const builtModality = [
      asArray(arch.input_modalities).join('+'),
      asArray(arch.output_modalities).join('+'),
    ]
      .filter(Boolean)
      .join('→');
    const modality = str(arch.modality) ?? (builtModality || undefined);
    const extraPricing: { label: string; value: string }[] = [];
    for (const [k, v] of Object.entries(pricing)) {
      if (k === 'prompt' || k === 'completion') continue;
      const n = num(v);
      if (n !== undefined && n > 0) extraPricing.push({ label: humanize(k), value: `$${v}` });
    }
    return {
      id: String(m.id ?? ''),
      name: str(m.name),
      description: str(m.description),
      contextTokens: num(top.context_length) ?? num(m.context_length),
      maxOutputTokens: num(top.max_completion_tokens),
      inputPricePerM: perMillion(pricing.prompt),
      outputPricePerM: perMillion(pricing.completion),
      extraPricing: extraPricing.length ? extraPricing : undefined,
      modality,
      kind: kindFromId(String(m.id ?? '')),
      created: isoFromEpochSeconds(m.created),
      raw,
    };
  });
}

/** OpenAI `/v1/models` (also xAI/DeepSeek/HF OpenAI-compatible) → bare ids. */
export function parseOpenAiLike(data: unknown[]): ExplorerModel[] {
  return data.map((raw) => {
    const m = rec(raw);
    const id = String(m.id ?? '');
    return {
      id,
      kind: kindFromId(id),
      created: isoFromEpochSeconds(m.created),
      raw,
    };
  });
}

/** Anthropic `/v1/models` → id + display_name + created_at. */
export function parseAnthropic(data: unknown[]): ExplorerModel[] {
  return data.map((raw) => {
    const m = rec(raw);
    return {
      id: String(m.id ?? ''),
      name: str(m.display_name),
      kind: 'chat',
      created: str(m.created_at),
      raw,
    };
  });
}

/** Google `/v1beta/models` → context limits + supported methods. */
export function parseGoogle(models: unknown[]): ExplorerModel[] {
  return models.map((raw) => {
    const m = rec(raw);
    const fullName = String(m.name ?? ''); // "models/gemini-2.5-pro"
    const id = fullName.replace(/^models\//, '');
    const methods = asArray(m.supportedGenerationMethods).map(String);
    const kind = methods.includes('embedContent')
      ? 'embedding'
      : methods.includes('predict') || methods.includes('predictLongRunning')
        ? 'image'
        : 'chat';
    return {
      id,
      name: str(m.displayName),
      description: str(m.description),
      contextTokens: num(m.inputTokenLimit),
      maxOutputTokens: num(m.outputTokenLimit),
      kind,
      raw,
    };
  });
}

/** Mistral `/v1/models` → context + capabilities. */
export function parseMistral(data: unknown[]): ExplorerModel[] {
  return data.map((raw) => {
    const m = rec(raw);
    const caps = rec(m.capabilities);
    const id = String(m.id ?? '');
    const kind = id.toLowerCase().includes('embed')
      ? 'embedding'
      : caps.vision
        ? 'chat'
        : 'chat';
    return {
      id,
      name: str(m.name) ?? str(m.id),
      description: str(m.description),
      contextTokens: num(m.max_context_length),
      modality: caps.vision ? 'text+image→text' : undefined,
      kind,
      raw,
    };
  });
}

/** Cohere `/v1/models` → context + endpoints. */
export function parseCohere(models: unknown[]): ExplorerModel[] {
  return models.map((raw) => {
    const m = rec(raw);
    const endpoints = asArray(m.endpoints).map((e) => String(e).toLowerCase());
    const kind = endpoints.includes('embed')
      ? 'embedding'
      : endpoints.includes('rerank')
        ? 'rerank'
        : endpoints.includes('chat')
          ? 'chat'
          : 'other';
    return {
      id: String(m.name ?? ''),
      name: str(m.name),
      contextTokens: num(m.context_length),
      kind,
      raw,
    };
  });
}

/** xAI `/v1/language-models` → modalities + per-token prices (surfaced raw). */
export function parseXaiLanguageModels(models: unknown[]): ExplorerModel[] {
  return models.map((raw) => {
    const m = rec(raw);
    const input = asArray(m.input_modalities).map(String);
    const output = asArray(m.output_modalities).map(String);
    const modality =
      input.length || output.length ? `${input.join('+')}→${output.join('+')}` : undefined;
    // xAI prices are integers in a provider-specific unit; surface verbatim
    // rather than risk a wrong $/token conversion.
    const extraPricing: { label: string; value: string }[] = [];
    for (const k of [
      'prompt_text_token_price',
      'completion_text_token_price',
      'prompt_image_token_price',
      'cached_prompt_text_token_price',
      'search_price',
    ]) {
      const n = num(m[k]);
      if (n !== undefined && n > 0) extraPricing.push({ label: humanize(k), value: String(n) });
    }
    return {
      id: String(m.id ?? ''),
      modality,
      kind: 'chat',
      created: isoFromEpochSeconds(m.created),
      extraPricing: extraPricing.length ? extraPricing : undefined,
      raw,
    };
  });
}

// ── per-provider fetchers ────────────────────────────────────────────────────

type Fetcher = {
  /** True when a stored API key is required (false = public endpoint). */
  needsKey: boolean;
  fetch: (key: string | null) => Promise<ExplorerModel[]>;
};

const FETCHERS: Partial<Record<ProviderId, Fetcher>> = {
  openrouter: {
    needsKey: false,
    fetch: async () => {
      // OR splits its catalog across two endpoints — /v1/models is the
      // chat-and-image catalog, /v1/embeddings/models is published
      // separately (their explicit choice; the main catalog deliberately
      // excludes embedding routes). Both are keyless, same response shape,
      // disjoint by design. Fan out + concat so the /models page surfaces
      // everything OR routes — and the existing kindFromId classifier
      // auto-buckets `text-embedding-*` / `gemini-embedding-*` etc. into
      // the `embedding` filter chip with no extra wiring.
      //
      // Promise.allSettled so a flake on one endpoint doesn't blank the
      // whole page — the chat catalog is the bigger one and the more
      // commonly-needed view; embeddings is the augmentation.
      const [chat, embeddings] = await Promise.allSettled([
        getJson('https://openrouter.ai/api/v1/models'),
        getJson('https://openrouter.ai/api/v1/embeddings/models'),
      ]);
      const out: ExplorerModel[] = [];
      if (chat.status === 'fulfilled') {
        out.push(...parseOpenRouter(asArray(rec(chat.value).data)));
      }
      if (embeddings.status === 'fulfilled') {
        // Force kind='embedding' on this branch — source of truth is the
        // URL we fetched from, not the slug heuristic. 13 of OR's 25
        // embedding models (sentence-transformers, GTE, E5, BGE, MiniLM
        // families) lack 'embed' in their slug; `kindFromId` would
        // misclassify them as 'chat' and they'd vanish from the
        // embedding filter chip. Override here, not in kindFromId,
        // because the heuristic is still the right fallback when the
        // *URL* is ambiguous (the main /v1/models catalog).
        const embRows = parseOpenRouter(asArray(rec(embeddings.value).data)).map(
          (m): ExplorerModel => ({ ...m, kind: 'embedding' }),
        );
        out.push(...embRows);
      }
      if (chat.status === 'rejected' && embeddings.status === 'rejected') {
        // Surface the chat-catalog error since it's the dominant case;
        // operators recognising "openrouter is down" matters more than
        // the embedding-specific error wording.
        throw chat.reason instanceof Error ? chat.reason : new Error(String(chat.reason));
      }
      return out;
    },
  },
  openai: {
    needsKey: true,
    fetch: async (key) => {
      const body = rec(await getJson('https://api.openai.com/v1/models', {
        headers: { authorization: `Bearer ${key}` },
      }));
      return parseOpenAiLike(asArray(body.data));
    },
  },
  anthropic: {
    needsKey: true,
    fetch: async (key) => {
      const body = rec(await getJson('https://api.anthropic.com/v1/models?limit=1000', {
        headers: { 'x-api-key': key ?? '', 'anthropic-version': '2023-06-01' },
      }));
      return parseAnthropic(asArray(body.data));
    },
  },
  google: {
    needsKey: true,
    fetch: async (key) => {
      const body = rec(
        await getJson(
          `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(key ?? '')}`,
        ),
      );
      return parseGoogle(asArray(body.models));
    },
  },
  xai: {
    needsKey: true,
    fetch: async (key) => {
      const body = rec(await getJson('https://api.x.ai/v1/language-models', {
        headers: { authorization: `Bearer ${key}` },
      }));
      return parseXaiLanguageModels(asArray(body.models));
    },
  },
  mistral: {
    needsKey: true,
    fetch: async (key) => {
      const body = rec(await getJson('https://api.mistral.ai/v1/models', {
        headers: { authorization: `Bearer ${key}` },
      }));
      return parseMistral(asArray(body.data));
    },
  },
  cohere: {
    needsKey: true,
    fetch: async (key) => {
      const body = rec(await getJson('https://api.cohere.com/v1/models?page_size=1000', {
        headers: { authorization: `Bearer ${key}` },
      }));
      return parseCohere(asArray(body.models));
    },
  },
  deepseek: {
    needsKey: true,
    fetch: async (key) => {
      const body = rec(await getJson('https://api.deepseek.com/models', {
        headers: { authorization: `Bearer ${key}` },
      }));
      return parseOpenAiLike(asArray(body.data));
    },
  },
  huggingface: {
    needsKey: true,
    fetch: async (key) => {
      const body = rec(await getJson('https://router.huggingface.co/v1/models', {
        headers: { authorization: `Bearer ${key}` },
      }));
      return parseOpenAiLike(asArray(body.data));
    },
  },
  // deepgram / elevenlabs / assemblyai: voice/transcription — no LLM-style
  // model catalog in this explorer (left out of FETCHERS → reported unsupported).
};

// ── server-side caching ──────────────────────────────────────────────────────

/** Cache successful fetches per provider for a short window so navigating
 *  between providers (and re-renders) doesn't hammer the upstream APIs.
 *  Single-user app, so a process-global cache keyed by provider is fine. */
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<ProviderId, ProviderModelsResult>();

/**
 * Fetch a provider's model catalog (cached). Never throws — failures and
 * missing-key/unsupported states come back on the result object so the UI can
 * render them. `force` busts the cache (the page's Refresh button).
 */
export async function fetchProviderModels(
  ownerId: string,
  provider: ProviderId,
  opts: { force?: boolean } = {},
): Promise<ProviderModelsResult> {
  if (!opts.force) {
    const hit = cache.get(provider);
    if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return hit;
  }

  const fetcher = FETCHERS[provider];
  if (!fetcher) {
    return { provider, models: [], fetchedAt: Date.now(), unsupported: true };
  }

  let key: string | null = null;
  if (fetcher.needsKey) {
    key = await getApiKey(ownerId, provider);
    if (!key) {
      return { provider, models: [], fetchedAt: Date.now(), needsKey: true };
    }
  }

  try {
    const models = await fetcher.fetch(key);
    models.sort((a, b) => a.id.localeCompare(b.id));
    const result: ProviderModelsResult = { provider, models, fetchedAt: Date.now() };
    cache.set(provider, result);
    return result;
  } catch (err) {
    return {
      provider,
      models: [],
      fetchedAt: Date.now(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Provider ids this explorer can fetch a model list for. */
export function explorerCanFetch(provider: string): boolean {
  return isProviderId(provider) && FETCHERS[provider] !== undefined;
}

// ── search / sort / paginate (server-side, over the cached catalog) ───────────

export type ModelSort = 'name' | 'context' | 'input' | 'output' | 'created';

export type ModelQuery = {
  q?: string;
  kind?: string;
  sort?: ModelSort;
  limit: number;
  offset: number;
};

function cmpNum(a: number | undefined, b: number | undefined, dir: 1 | -1): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1; // undefined sinks to the end regardless of dir
  if (b === undefined) return -1;
  return (a - b) * dir;
}

/**
 * Filter + sort + paginate a fetched catalog. Kept here (not in the client) so
 * the /models page does its list shaping server-side per the apps/web list
 * convention (URL-driven SSR, no client-filtering of a loaded list). The source
 * list is a single cached provider fetch, so this operates in memory. `kinds`
 * is the distinct type set over the FULL list (for the type filter options).
 */
export function queryModels(
  models: ExplorerModel[],
  { q, kind, sort = 'name', limit, offset }: ModelQuery,
): { rows: ExplorerModel[]; total: number; kinds: string[] } {
  const kinds = Array.from(
    new Set(models.map((m) => m.kind).filter((k): k is string => Boolean(k))),
  ).sort();

  const needle = q?.trim().toLowerCase();
  let rows = models;
  if (needle) {
    rows = rows.filter(
      (m) =>
        m.id.toLowerCase().includes(needle) ||
        m.name?.toLowerCase().includes(needle) ||
        m.description?.toLowerCase().includes(needle),
    );
  }
  if (kind && kind !== 'all') rows = rows.filter((m) => m.kind === kind);

  const sorted = [...rows].sort((a, b) => {
    switch (sort) {
      case 'context':
        return cmpNum(a.contextTokens, b.contextTokens, -1);
      case 'input':
        return cmpNum(a.inputPricePerM, b.inputPricePerM, 1);
      case 'output':
        return cmpNum(a.outputPricePerM, b.outputPricePerM, 1);
      case 'created':
        return (b.created ?? '').localeCompare(a.created ?? '');
      default:
        return (a.name ?? a.id).localeCompare(b.name ?? b.id);
    }
  });

  return { rows: sorted.slice(offset, offset + limit), total: sorted.length, kinds };
}
