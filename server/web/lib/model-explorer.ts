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
 * The key is the one the caller picked (`keyId`, the agent form's key), else
 * the provider's own key on file by the one lookup (findProviderKeyId: the
 * 'default' label first, else the oldest key of that service).
 */
import { findProviderKeyId, getApiKeyById } from '@mantle/api-keys';
import {
  anthropicHeaders,
  isProviderId,
  type ProviderCredential,
  type ProviderId,
} from '@mantle/voice';
import {
  contextLimitForRoute,
  contextSourceForRoute,
  refreshModelCatalog,
  type ContextSource,
} from '@mantle/tracing';
import type { ExplorerModel, ModelSort } from '@mantle/client-types';
import { kindFromModalities } from '@mantle/client-types/model-pools';
import {
  NET_TIMEOUTS,
  ProviderHttpError,
  publicProviderErrorMessage,
  timeoutSignal,
} from '@mantle/std';

export type { ExplorerModel, ModelSort };

export type ProviderModelsResult = {
  provider: ProviderId;
  models: ExplorerModel[];
  /** Epoch ms of this fetch. */
  fetchedAt: number;
  /** Provider needs a key and none is configured. */
  needsKey?: boolean;
  /** Provider has no usable model-list API in this explorer. */
  unsupported?: boolean;
  /** Why the fetch failed: a fixed sentence (publicProviderErrorMessage),
   *  never the provider's body, which can carry an account id or part of a
   *  key. A refused key reads "The provider refused the API key." */
  error?: string;
};

const FETCH_TIMEOUT_MS = NET_TIMEOUTS.modelExplorer;

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
/**
 * Bucket an OpenRouter row by what it PRODUCES — the catalog says so directly
 * in `architecture.output_modalities`, so nothing here is a guess. The
 * ordering lives in `@mantle/client-types/model-pools` next to
 * `poolModelIssue`, shared with the Curator's `model_catalog` filter so the
 * two cannot drift. Only a row with NO modalities at all falls back to the
 * slug heuristic.
 */
function kindForOpenRouter(output: string[], id: string): string {
  return output.length > 0 ? kindFromModalities(output) : kindFromId(id);
}

/** Infer a coarse model type from its id when the API doesn't say. Still the
 *  right answer for the providers whose list API returns bare ids (OpenAI,
 *  DeepSeek, Hugging Face) — but never for OpenRouter, which publishes the
 *  modalities. */
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
    signal: timeoutSignal(FETCH_TIMEOUT_MS),
    headers: { accept: 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // The provider is named by fetchProviderModels, which knows it.
    throw new ProviderHttpError({ provider: 'models', status: res.status, body, what: 'models' });
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
    const outputModalities = asArray(arch.output_modalities).map(String);
    const builtModality = [asArray(arch.input_modalities).join('+'), outputModalities.join('+')]
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
      kind: kindForOpenRouter(outputModalities, String(m.id ?? '')),
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
      // The Models API publishes the context window as `max_input_tokens`
      // and the output cap as `max_tokens`; an older answer has neither.
      contextTokens: num(m.max_input_tokens),
      maxOutputTokens: num(m.max_tokens),
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
    const kind = id.toLowerCase().includes('embed') ? 'embedding' : caps.vision ? 'chat' : 'chat';
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
  fetch: (credential: ProviderCredential | null) => Promise<ExplorerModel[]>;
};

const FETCHERS: Partial<Record<ProviderId, Fetcher>> = {
  openrouter: {
    needsKey: false,
    fetch: async () => {
      // ONE call for the whole catalog. `output_modalities=all` is the
      // difference between the text-out slice (430 rows on 2026-09-07) and
      // everything OpenRouter routes (581): the image and video generators,
      // the speech and transcription engines, embeddings and rerank.
      //
      // This replaces a two-endpoint fan-out (/models + /embeddings/models)
      // plus a slug-substring classifier plus a hardcoded kind override for
      // the embeddings branch — all of which existed to reconstruct, badly,
      // the `output_modalities` the API publishes on every row. The `all`
      // filter is also a superset of /v1/embeddings/models (37 vs 33).
      const body = rec(await getJson('https://openrouter.ai/api/v1/models?output_modalities=all'));
      return parseOpenRouter(asArray(body.data));
    },
  },
  openai: {
    needsKey: true,
    fetch: async (credential) => {
      const body = rec(
        await getJson('https://api.openai.com/v1/models', {
          headers: { authorization: `Bearer ${credential?.apiKey ?? ''}` },
        }),
      );
      return parseOpenAiLike(asArray(body.data));
    },
  },
  anthropic: {
    needsKey: true,
    fetch: async (credential) => {
      const body = rec(
        await getJson('https://api.anthropic.com/v1/models?limit=1000', {
          // THE Anthropic headers (the version, and the workspace id when the
          // key's credential carries one): built in the adapter, never here.
          headers: anthropicHeaders(credential ?? { apiKey: '' }),
        }),
      );
      return parseAnthropic(asArray(body.data));
    },
  },
  google: {
    needsKey: true,
    fetch: async (credential) => {
      const body = rec(
        await getJson(
          `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(credential?.apiKey ?? '')}`,
        ),
      );
      return parseGoogle(asArray(body.models));
    },
  },
  xai: {
    needsKey: true,
    fetch: async (credential) => {
      const body = rec(
        await getJson('https://api.x.ai/v1/language-models', {
          headers: { authorization: `Bearer ${credential?.apiKey ?? ''}` },
        }),
      );
      return parseXaiLanguageModels(asArray(body.models));
    },
  },
  mistral: {
    needsKey: true,
    fetch: async (credential) => {
      const body = rec(
        await getJson('https://api.mistral.ai/v1/models', {
          headers: { authorization: `Bearer ${credential?.apiKey ?? ''}` },
        }),
      );
      return parseMistral(asArray(body.data));
    },
  },
  cohere: {
    needsKey: true,
    fetch: async (credential) => {
      const body = rec(
        await getJson('https://api.cohere.com/v1/models?page_size=1000', {
          headers: { authorization: `Bearer ${credential?.apiKey ?? ''}` },
        }),
      );
      return parseCohere(asArray(body.models));
    },
  },
  deepseek: {
    needsKey: true,
    fetch: async (credential) => {
      const body = rec(
        await getJson('https://api.deepseek.com/models', {
          headers: { authorization: `Bearer ${credential?.apiKey ?? ''}` },
        }),
      );
      return parseOpenAiLike(asArray(body.data));
    },
  },
  mammouth: {
    needsKey: true,
    fetch: async (credential) => {
      const body = rec(
        await getJson('https://api.mammouth.ai/v1/models', {
          headers: { authorization: `Bearer ${credential?.apiKey ?? ''}` },
        }),
      );
      return parseOpenAiLike(asArray(body.data));
    },
  },
  huggingface: {
    needsKey: true,
    fetch: async (credential) => {
      const body = rec(
        await getJson('https://router.huggingface.co/v1/models', {
          headers: { authorization: `Bearer ${credential?.apiKey ?? ''}` },
        }),
      );
      return parseOpenAiLike(asArray(body.data));
    },
  },
  // deepgram / elevenlabs / assemblyai: voice/transcription — no LLM-style
  // model catalog in this explorer (left out of FETCHERS → reported unsupported).
};

// ── server-side caching ──────────────────────────────────────────────────────

/** Cache successful fetches for a short window so navigating between
 *  providers (and re-renders) doesn't hammer the upstream APIs. Keyed by the
 *  provider AND the key that fetched the list: two keys of one provider can
 *  see different catalogs (a project-scoped key, a tier), and one key's list
 *  must not answer for the other. A keyless provider (OpenRouter's public
 *  catalog) keeps one entry. */
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, ProviderModelsResult>();

/** One fetch per cache slot at a time: a caller that finds one running gets
 *  its answer (N agents on one key on a cold cache make one request). */
const inflight = new Map<string, Promise<ProviderModelsResult>>();

/** When a slot's last fetch failed. The dashboard's background fetch
 *  (cachedListedWindow) does not try that slot again for FAILURE_BACKOFF_MS,
 *  so a failing key (an unscoped Anthropic key, a revoked key, an outage) costs
 *  one request and one log line per window, not one per poll per tab. A fetch
 *  the owner asks for (the form, Refresh) is not held back, and its success
 *  clears the mark. */
const FAILURE_BACKOFF_MS = 5 * 60 * 1000;
const failedAt = new Map<string, number>();

/** The cache entry for `provider` fetched with key `keyId` (null: keyless). */
export function modelCacheKey(provider: ProviderId, keyId: string | null): string {
  return keyId ? `${provider}:${keyId}` : provider;
}

/** Test seam: forget every cached catalog. */
export function clearModelCache(): void {
  cache.clear();
  inflight.clear();
  failedAt.clear();
}

/**
 * Fetch a provider's model catalog (cached). Never throws — failures and
 * missing-key/unsupported states come back on the result object so the UI can
 * render them. `force` busts the cache (the page's Refresh button). `keyId`
 * picks the key to list with; the caller has checked the owner holds it and
 * that it is this provider's (GET /api/models). Without one, the provider's
 * own key on file (findProviderKeyId).
 */
export async function fetchProviderModels(
  ownerId: string,
  provider: ProviderId,
  opts: { force?: boolean; keyId?: string | null } = {},
): Promise<ProviderModelsResult> {
  const fetcher = FETCHERS[provider];
  if (!fetcher) {
    return { provider, models: [], fetchedAt: Date.now(), unsupported: true };
  }

  const keyId = fetcher.needsKey
    ? (opts.keyId ?? (await findProviderKeyId(ownerId, provider)))
    : null;
  if (fetcher.needsKey && !keyId) {
    return { provider, models: [], fetchedAt: Date.now(), needsKey: true };
  }
  const slot = modelCacheKey(provider, keyId);
  if (!opts.force) {
    const hit = cache.get(slot);
    if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return hit;
  }
  // No await between this check and the set: concurrent callers share one.
  const running = inflight.get(slot);
  if (running) return running;
  const pending = fetchIntoSlot(provider, fetcher, keyId, slot).finally(() =>
    inflight.delete(slot),
  );
  inflight.set(slot, pending);
  return pending;
}

async function fetchIntoSlot(
  provider: ProviderId,
  fetcher: Fetcher,
  keyId: string | null,
  slot: string,
): Promise<ProviderModelsResult> {
  let credential: ProviderCredential | null = null;
  if (keyId) {
    credential = await getApiKeyById(keyId);
    if (!credential) {
      return { provider, models: [], fetchedAt: Date.now(), needsKey: true };
    }
  }

  try {
    const models = await withRouteContext(provider, await fetcher.fetch(credential));
    models.sort((a, b) => a.id.localeCompare(b.id));
    const result: ProviderModelsResult = { provider, models, fetchedAt: Date.now() };
    cache.set(slot, result);
    failedAt.delete(slot);
    return result;
  } catch (err) {
    failedAt.set(slot, Date.now());
    const named =
      err instanceof ProviderHttpError
        ? new ProviderHttpError({ provider, status: err.status, body: err.body, what: 'models' })
        : err;
    return {
      provider,
      models: [],
      fetchedAt: Date.now(),
      error: publicProviderErrorMessage(named, `model-explorer ${provider}`),
    };
  }
}

/**
 * THE context window of a model as the brain reports it, for the agent
 * form's model list (withRouteContext, read by /api/models) and the
 * dashboard's context bars (agentContextWindow) alike, so the two agree:
 * the provider's own figure when its model list published one (`listed`:
 * Anthropic's `max_input_tokens` from its Models API), else the OpenRouter
 * catalog's window for the model's OpenRouter id (contextLimitForRoute:
 * vendor prefix + id normalization, no table of models), else none. The
 * provider's own figure reads as `live`; a mapped one keeps the OpenRouter
 * catalog's source.
 */
export function contextWindowFor(
  provider: string | null | undefined,
  model: string,
  listed?: number | null,
): { limit: number | null; source: ContextSource } {
  const mapped = contextLimitForRoute(provider, model);
  if (listed && listed > 0 && listed !== mapped) return { limit: listed, source: 'live' };
  return { limit: mapped, source: contextSourceForRoute(provider, model) };
}

/**
 * A direct provider's models with the context window filled where its own
 * list gave none (contextWindowFor). The provider's own number always wins;
 * a model OpenRouter does not list stays without one. OpenRouter's own list
 * is already complete.
 */
export async function withRouteContext(
  provider: ProviderId,
  models: ExplorerModel[],
): Promise<ExplorerModel[]> {
  if (provider === 'openrouter' || models.every((m) => m.contextTokens)) return models;
  await refreshModelCatalog();
  return models.map((m) => {
    if (m.contextTokens) return m;
    const { limit } = contextWindowFor(provider, m.id);
    return limit ? { ...m, contextTokens: limit } : m;
  });
}

/**
 * The context window of an agent's model for the dashboard: contextWindowFor
 * over the same provider model list the agent form shows (this module's
 * cache, for the agent's key), so the form and the dashboard say the same
 * number. Never waits on a provider: a list not cached yet is fetched in the
 * background for the next render, and this one uses the OpenRouter mapping.
 */
type ContextAgent = {
  provider: string | null;
  model: string;
  apiKeyId: string | null;
  /** The agent's own host (a custom gateway): its key is meant for that host,
   *  so the provider's public model list is never fetched with it. */
  baseUrl?: string | null;
};

export async function agentContextWindow(
  ownerId: string,
  agent: ContextAgent,
): Promise<{ limit: number | null; source: ContextSource }> {
  const listed = await cachedListedWindow(ownerId, agent).catch(() => undefined);
  return contextWindowFor(agent.provider, agent.model, listed);
}

async function cachedListedWindow(
  ownerId: string,
  agent: ContextAgent,
): Promise<number | undefined> {
  const provider = agent.provider;
  if (!provider || provider === 'openrouter' || !isProviderId(provider)) return undefined;
  if (agent.baseUrl?.trim()) return undefined;
  const fetcher = FETCHERS[provider];
  if (!fetcher) return undefined;
  const keyId = fetcher.needsKey
    ? (agent.apiKeyId ?? (await findProviderKeyId(ownerId, provider)))
    : null;
  if (fetcher.needsKey && !keyId) return undefined;
  const slot = modelCacheKey(provider, keyId);
  const hit = cache.get(slot);
  const failed = failedAt.get(slot);
  const backingOff = failed !== undefined && Date.now() - failed < FAILURE_BACKOFF_MS;
  if ((!hit || Date.now() - hit.fetchedAt >= CACHE_TTL_MS) && !backingOff) {
    void fetchProviderModels(ownerId, provider, { keyId }).catch(() => {});
  }
  const id = agent.model.trim().toLowerCase();
  return hit?.models.find((m) => m.id.toLowerCase() === id)?.contextTokens;
}

/** Provider ids this explorer can fetch a model list for. */
export function explorerCanFetch(provider: string): boolean {
  return isProviderId(provider) && FETCHERS[provider] !== undefined;
}

// ── search / sort / paginate (server-side, over the cached catalog) ───────────

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
 * the /models page does its list shaping server-side per the server/web list
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
