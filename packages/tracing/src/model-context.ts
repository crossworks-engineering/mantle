/**
 * Model → max-context-window-tokens.
 *
 * The AUTHORITATIVE source is OpenRouter's public `/api/v1/models`
 * response (`top_provider.context_length`), fetched and cached at runtime
 * by {@link refreshModelCatalog} (which also captures vision capability —
 * see {@link modelSupportsVision}). The static map below is only a
 * FALLBACK — used before the first live fetch lands or when OpenRouter is
 * unreachable. Keep it roughly current, but live data always wins.
 *
 * Why live: provider context windows change without notice (e.g. Claude
 * Sonnet/Opus moving to a 1M default), and a hand-maintained table
 * silently goes stale — which made the dashboard's "context %" over-report
 * usage by 5×. The fetch is keyless (the catalog is public), TTL-gated,
 * and fails safe to this table.
 *
 * Values are total context length (input + output).
 */
const FALLBACK_CONTEXT_LIMITS: Record<string, number> = {
  // Anthropic via OpenRouter — 4.x sonnet/opus default to a 1M window.
  'anthropic/claude-haiku-4.5': 200_000,
  'anthropic/claude-sonnet-4.6': 1_000_000,
  'anthropic/claude-opus-4.7': 1_000_000,
  'anthropic/claude-opus-4.7-fast': 1_000_000,

  // OpenAI via OpenRouter
  'openai/gpt-4o': 128_000,
  'openai/gpt-4o-mini': 128_000,
  'openai/gpt-4-turbo': 128_000,
  'openai/o1': 200_000,
  'openai/o1-mini': 128_000,

  // DeepSeek
  'deepseek/deepseek-chat': 64_000,
  'deepseek/deepseek-reasoner': 64_000,

  // Google
  'google/gemini-2.5-flash': 1_000_000,
  'google/gemini-2.5-pro': 2_000_000,

  // xAI
  'x-ai/grok-2': 131_072,
  'x-ai/grok-4': 256_000,
};

/** OpenRouter's public model catalog — no API key required. */
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
/** Re-fetch the live catalog at most this often. */
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000; // 6h
/** Abort the catalog fetch if it stalls — must never hang a caller. */
const CATALOG_FETCH_TIMEOUT_MS = 8_000;

/** What we keep per model from the live catalog. */
export type LiveModelInfo = {
  /** Total context window (input + output) for the default route. */
  contextLength: number;
  /** Whether the model accepts image input (architecture.input_modalities). */
  vision: boolean;
  /** USD per 1M input/prompt tokens, when OpenRouter returns pricing. 0 is a
   *  legitimate value (free routes); undefined means "the provider didn't
   *  return a pricing field" and the UI should render "pricing unavailable"
   *  rather than guessing. */
  inputPricePerM?: number;
  /** USD per 1M output/completion tokens. Same semantics as inputPricePerM. */
  outputPricePerM?: number;
};

let liveModels: Record<string, LiveModelInfo> | null = null;
let liveFetchedAt = 0;
let inFlight: Promise<void> | null = null;

type OpenRouterModel = {
  id?: string;
  context_length?: number | null;
  top_provider?: { context_length?: number | null } | null;
  architecture?: { input_modalities?: string[] | null } | null;
  /** OpenRouter encodes pricing as **strings in USD per single token** —
   *  e.g. `"0.0000025"` for $2.50 per 1M. Multiply by 1e6 for the per-million
   *  view the UI shows. Other fields (`request`, `image`, `web_search`, …)
   *  exist for niche cases; we surface only prompt/completion at the model
   *  cache layer. */
  pricing?: {
    prompt?: string | null;
    completion?: string | null;
  } | null;
};

/** Parse a single OpenRouter `pricing.{prompt,completion}` value (USD per
 *  token, string-encoded) into USD per 1M. Returns undefined for missing /
 *  non-numeric / empty input so callers can distinguish "free" (0) from
 *  "unknown". Tight on the empty-string case specifically — `Number('')`
 *  is 0 in JS, which would silently promote malformed data into "free". */
function parsePerMillion(raw: string | null | undefined): number | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n * 1_000_000 : undefined;
}

/** Parse the OpenRouter catalog into a slug→{contextLength, vision, pricing}
 *  map. Context prefers the default route's actual window
 *  (`top_provider.context_length`), falling back to the model-level
 *  `context_length`. Vision is read from `architecture.input_modalities`
 *  (image input ⇒ multimodal). Pricing is read from `pricing.{prompt,
 *  completion}` and converted to per-1M USD; absent fields stay undefined
 *  so the UI can show "pricing unavailable" rather than guessing $0.
 *  Exported for unit testing — production calls it via
 *  {@link refreshModelCatalog}. */
export function parseCatalog(models: OpenRouterModel[]): Record<string, LiveModelInfo> {
  const out: Record<string, LiveModelInfo> = {};
  for (const m of models) {
    const id = typeof m.id === 'string' ? m.id.toLowerCase() : '';
    if (!id) continue;
    const top = m.top_provider?.context_length;
    const base = m.context_length;
    const ctx =
      typeof top === 'number' && top > 0
        ? top
        : typeof base === 'number' && base > 0
          ? base
          : 0;
    if (ctx <= 0) continue;
    const mods = m.architecture?.input_modalities;
    const vision = Array.isArray(mods) && mods.includes('image');
    const inputPricePerM = parsePerMillion(m.pricing?.prompt);
    const outputPricePerM = parsePerMillion(m.pricing?.completion);
    out[id] = { contextLength: ctx, vision, inputPricePerM, outputPricePerM };
  }
  return out;
}

/**
 * Refresh the live model catalog from OpenRouter, at most once per TTL.
 * Populates context windows AND vision capability. Safe to call on every
 * request: TTL-gated, dedupes concurrent callers, **never throws**, and
 * keeps the last-good cache on failure (degrading to last-known, then to
 * the static fallbacks). Await it for guaranteed-fresh data; fire-and-forget
 * is also fine since the fallbacks are accurate.
 */
export async function refreshModelCatalog(force = false): Promise<void> {
  const fresh = liveModels && Date.now() - liveFetchedAt < CATALOG_TTL_MS;
  if (fresh && !force) return;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await fetch(OPENROUTER_MODELS_URL, {
        signal: AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS),
        headers: { accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`openrouter /models ${res.status}`);
      const body = (await res.json()) as { data?: OpenRouterModel[] };
      const parsed = parseCatalog(body.data ?? []);
      // Only replace the cache on a non-empty parse — a malformed/empty
      // response shouldn't wipe good data.
      if (Object.keys(parsed).length > 0) {
        liveModels = parsed;
        liveFetchedAt = Date.now();
      }
    } catch (err) {
      // Decorative metadata — never let a failed refresh break a caller.
      console.error(
        '[model-context] live model-catalog refresh failed:',
        err instanceof Error ? err.message : err,
      );
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export type ContextSource = 'live' | 'fallback' | 'unknown';

/** Total context window for a model slug: live OpenRouter data if cached,
 *  else the static fallback, else null. Sync — call
 *  {@link refreshModelCatalog} first if you want guaranteed-fresh data. */
export function contextLimitFor(modelSlug: string | null | undefined): number | null {
  if (!modelSlug) return null;
  const key = modelSlug.toLowerCase();
  return liveModels?.[key]?.contextLength ?? FALLBACK_CONTEXT_LIMITS[key] ?? null;
}

/** Provenance of a slug's limit — for showing the user where it came from. */
export function contextSourceFor(modelSlug: string | null | undefined): ContextSource {
  if (!modelSlug) return 'unknown';
  const key = modelSlug.toLowerCase();
  if (liveModels?.[key] != null) return 'live';
  if (FALLBACK_CONTEXT_LIMITS[key] != null) return 'fallback';
  return 'unknown';
}

/** Merged slug→limit map (live overrides fallback) for bulk UI use, e.g.
 *  the agents form's per-model readout. */
export function contextLimitMap(): Record<string, number> {
  const live: Record<string, number> = {};
  if (liveModels) {
    for (const [k, v] of Object.entries(liveModels)) live[k] = v.contextLength;
  }
  return { ...FALLBACK_CONTEXT_LIMITS, ...live };
}

/** Epoch ms of the last successful live fetch, or null if it hasn't run. */
export function contextLimitsFetchedAt(): number | null {
  return liveFetchedAt || null;
}

/** Per-1M USD pricing for a model slug, or null if the slug isn't in the
 *  live catalog or the catalog hasn't loaded yet. Either side may still be
 *  undefined (provider returned a partial pricing object) — callers should
 *  check before formatting.
 *
 *  This also serves the direct-provider workers case: if a worker is stored
 *  as `provider='anthropic', model='claude-sonnet-4-5'`, build the lookup
 *  key as `anthropic/claude-sonnet-4-5` and the OpenRouter catalog will
 *  almost always have pricing for it — OpenRouter aggregates upstream, so
 *  its catalog covers what each direct provider sells. */
export function pricingFor(
  modelSlug: string | null | undefined,
): { inputPricePerM?: number; outputPricePerM?: number } | null {
  if (!modelSlug) return null;
  const key = modelSlug.toLowerCase();
  const entry = liveModels?.[key];
  if (!entry) return null;
  if (entry.inputPricePerM == null && entry.outputPricePerM == null) return null;
  return {
    inputPricePerM: entry.inputPricePerM,
    outputPricePerM: entry.outputPricePerM,
  };
}

/** Bulk slug→pricing map for the UI to attach pricing badges to a list of
 *  models. Only slugs that have at least one priced side are included —
 *  consumers can treat absence as "pricing unavailable". */
export function pricingMap(): Record<string, { inputPricePerM?: number; outputPricePerM?: number }> {
  if (!liveModels) return {};
  const out: Record<string, { inputPricePerM?: number; outputPricePerM?: number }> = {};
  for (const [k, v] of Object.entries(liveModels)) {
    if (v.inputPricePerM == null && v.outputPricePerM == null) continue;
    out[k] = { inputPricePerM: v.inputPricePerM, outputPricePerM: v.outputPricePerM };
  }
  return out;
}

/**
 * Whether a model accepts image input directly (multimodal). The
 * AUTHORITATIVE source is the live OpenRouter catalog's
 * `architecture.input_modalities` (populated by {@link refreshModelCatalog});
 * for slugs not in the catalog, or before the first fetch lands, it falls
 * back to a family pattern-match. Used to decide whether the responder can
 * be shown a raw image vs. needing a vision worker to transcribe it first.
 *
 * Warm the catalog (fire-and-forget `refreshModelCatalog()`) wherever this
 * is consumed so the live answer kicks in — the heuristic is only the
 * cold-start / unlisted-slug safety net.
 */
export function modelSupportsVision(modelSlug: string | null | undefined): boolean {
  if (!modelSlug) return false;
  const key = modelSlug.toLowerCase();
  const live = liveModels?.[key];
  if (live) return live.vision;
  return modelSupportsVisionHeuristic(key);
}

/** Family pattern-match fallback for vision support — used only when the
 *  live catalog hasn't loaded or doesn't list the slug. Lower-case slug in.
 *  Pattern-based so new versions of known multimodal families keep working. */
function modelSupportsVisionHeuristic(s: string): boolean {
  // Anthropic Claude 3+ — all current Claude chat models are multimodal.
  if (s.startsWith('anthropic/claude-')) return true;
  // OpenAI 4o / 4.1 / 5 / reasoning families (mini variants included).
  if (/^openai\/(gpt-4o|gpt-4\.1|gpt-5|chatgpt-4o|o1|o3|o4)/.test(s)) return true;
  // Google Gemini — all current models are multimodal.
  if (s.startsWith('google/gemini')) return true;
  // xAI Grok vision-capable lines.
  if (s.startsWith('x-ai/grok-4') || s.includes('grok-2-vision')) return true;
  // Open vision-language variants (Qwen-VL, Llama vision, Pixtral, …).
  if (s.includes('-vl') || s.includes('vision') || s.includes('pixtral')) return true;
  return false;
}

/**
 * Maximum decoded image size (bytes) a model's provider will accept for a
 * single inline image. Used by the vision routing to decide whether to send
 * the raw picture to a vision-capable responder, or fall back to a text
 * transcript when it's too big.
 *
 * Anthropic — including `anthropic/*` routed through OpenRouter to Amazon
 * Bedrock — rejects images over ~5 MB with an opaque `400 "Could not process
 * image"`, which `@openrouter/sdk` then masks as a `ResponseValidationError`.
 * We keep a safety margin under that. OpenAI accepts up to 20 MB. Anything
 * uncatalogued gets the conservative Anthropic limit: a too-low guard merely
 * degrades to the transcript fallback, whereas a too-high one is a hard 500.
 */
export function maxImageBytesFor(modelSlug: string | null | undefined): number {
  const ANTHROPIC_LIMIT = 4_500_000; // ~4.5 MB — under Bedrock's ~5 MB cap
  const OPENAI_LIMIT = 18_000_000; // ~18 MB — under OpenAI's 20 MB cap
  if (!modelSlug) return ANTHROPIC_LIMIT;
  if (modelSlug.toLowerCase().startsWith('openai/')) return OPENAI_LIMIT;
  return ANTHROPIC_LIMIT;
}
