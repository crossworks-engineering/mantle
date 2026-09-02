/**
 * Model-curation builtins — the Curator specialist's kit.
 *
 * Two halves:
 *   READ  — OpenRouter's public Data API (rankings / benchmarks / task
 *           classifications; bearer = the owner's OpenRouter key) plus the
 *           keyless model catalog with live pricing. This is the evidence.
 *   WRITE — the curated_models store behind /models/pools. The specialist
 *           turns evidence into per-pool shortlists; the owner can always
 *           hand-edit in /models afterwards.
 *
 * Boundaries that matter:
 *   - Curation NEVER touches live routing. No tool here can change what model
 *     an agent or worker actually runs — pools are advisory shortlists the
 *     owner adopts by hand (cost-safety: model switches stay explicit).
 *   - Owner-only (group `model-curation`), and read tools are subject to
 *     OpenRouter's Data API limits (30/min, 500/day) — a handful of calls per
 *     curation pass, not a polling target.
 *   - Rankings/app data is CC BY 4.0 with required attribution; the tools
 *     return the attribution line so downstream prose can carry it.
 */

import { and, asc, eq } from 'drizzle-orm';
import { db, curatedModels, type CuratedPricing, type CuratedRoute } from '@mantle/db';
import { MODEL_POOLS, MODEL_POOL_IDS, poolModelIssue } from '@mantle/client-types/model-pools';
import { OPENAI_TTS_MODELS, OPENAI_STT_MODELS } from '@mantle/voice-client/catalog';
import { GOOGLE_TTS_MODELS, GOOGLE_STT_MODELS } from '@mantle/voice-client/catalogs/google';
import {
  ELEVENLABS_TTS_MODELS,
  ELEVENLABS_STT_MODELS,
} from '@mantle/voice-client/catalogs/elevenlabs';
import { DEEPGRAM_STT_MODELS } from '@mantle/voice-client/catalogs/deepgram';
import { ASSEMBLYAI_STT_MODELS } from '@mantle/voice-client/catalogs/assemblyai';
import { XAI_TTS_MODEL_ID, XAI_STT_MODELS } from '@mantle/voice-client/catalogs/xai';
import type { BuiltinToolDef, ToolHandlerResult } from './types';
import { refuseTeamSurface } from './builtins-crawl';
import { resolveOpenRouterKey } from './builtins-research';
import { str } from './coerce';

const OR_BASE = 'https://openrouter.ai/api/v1';
const DATA_TIMEOUT_MS = 25_000;

async function orGet(
  path: string,
  params: Record<string, string | undefined>,
  apiKey?: string,
): Promise<{ ok: true; json: unknown } | { ok: false; error: string }> {
  const url = new URL(`${OR_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  try {
    const res = await fetch(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(DATA_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      return { ok: false, error: `OpenRouter ${path} returned ${res.status}: ${body}` };
    }
    return { ok: true, json: await res.json() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function needKey(): string {
  return 'no openrouter API key configured — the Data API needs one; add it at /settings/keys';
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function num(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : 0;
}

// ─── model catalog (keyless, cached) ───────────────────────────────

type CatalogModel = {
  id: string;
  name: string | null;
  /** Which provider this slug belongs to — the route to write into a pool. */
  provider: string;
  /** 'tts' | 'stt' for the voice supplement; absent for LLM catalog rows. */
  kind?: 'tts' | 'stt';
  inputPerM: number | null;
  outputPerM: number | null;
  contextTokens: number | null;
  modality: string | null;
  /** `architecture.input_modalities` — what the model ACCEPTS. */
  inputModalities: string[];
  /** `architecture.output_modalities` — what it PRODUCES. The half that
   *  separates an image READER from an image GENERATOR (both accept images);
   *  `poolModelIssue` uses it to keep a generator out of a text-out pool. */
  outputModalities: string[];
  created: number | null;
};

/**
 * The voice supplement: OpenRouter's /models endpoint is the CHAT catalog and
 * omits dedicated TTS/STT engines entirely (grok-voice, whisper, ElevenLabs,
 * Deepgram, …), which made the tts/stt pools near-uncuratable. These are
 * Mantle's own WIRED voice catalogs — every slug here is one an adapter can
 * actually dispatch to. Pricing is null on purpose: voice billing is
 * per-character/per-minute, not per-token, and inventing a per-M figure would
 * poison the pool snapshots. Exported for unit tests.
 */
export function voiceCatalogSupplement(): CatalogModel[] {
  const base = {
    inputPerM: null,
    outputPerM: null,
    contextTokens: null,
    modality: 'audio',
    inputModalities: [],
    outputModalities: [],
    created: null,
  };
  const out: CatalogModel[] = [];
  const add = (provider: string, kind: 'tts' | 'stt', id: string, name: string) =>
    out.push({ id, name, provider, kind, ...base });

  for (const m of OPENAI_TTS_MODELS) add('openai', 'tts', m.id, m.label);
  for (const m of OPENAI_STT_MODELS) add('openai', 'stt', m.id, m.label);
  for (const id of GOOGLE_TTS_MODELS) add('google', 'tts', id, id);
  for (const m of GOOGLE_STT_MODELS) add('google', 'stt', m.id, m.label);
  for (const m of ELEVENLABS_TTS_MODELS) add('elevenlabs', 'tts', m.id, m.label);
  for (const m of ELEVENLABS_STT_MODELS) add('elevenlabs', 'stt', m.id, m.label);
  for (const m of DEEPGRAM_STT_MODELS) add('deepgram', 'stt', m.id, m.label);
  for (const m of ASSEMBLYAI_STT_MODELS) add('assemblyai', 'stt', m.id, m.label);
  add('xai', 'tts', XAI_TTS_MODEL_ID, 'Grok Voice');
  for (const m of XAI_STT_MODELS) add('xai', 'stt', m.id, m.label);
  // The OpenRouter AUDIO-endpoint slugs Mantle ships as worker defaults —
  // reachable through the owner's OpenRouter key but absent from /models.
  // Keep in sync with MANIFEST_WORKERS (tts/stt defaults).
  add('openrouter', 'tts', 'x-ai/grok-voice-tts-1.0', 'Grok Voice (via OpenRouter)');
  add(
    'openrouter',
    'stt',
    'openai/gpt-4o-mini-transcribe',
    'GPT-4o Mini Transcribe (via OpenRouter)',
  );
  return out;
}

let catalogCache: { at: number; models: CatalogModel[] } | null = null;
const CATALOG_TTL_MS = 5 * 60_000;

async function loadCatalog(): Promise<
  { ok: true; models: CatalogModel[] } | { ok: false; error: string }
> {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
    return { ok: true, models: catalogCache.models };
  }
  const res = await orGet('/models', {});
  if (!res.ok) return res;
  const data = (res.json as { data?: unknown[] }).data ?? [];
  const perM = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n * 1_000_000 : null;
  };
  const models: CatalogModel[] = [];
  for (const raw of data) {
    const m = raw as Record<string, unknown>;
    if (typeof m.id !== 'string') continue;
    const pricing = (m.pricing ?? {}) as Record<string, unknown>;
    const arch = (m.architecture ?? {}) as Record<string, unknown>;
    models.push({
      id: m.id,
      name: typeof m.name === 'string' ? m.name : null,
      provider: 'openrouter',
      inputPerM: perM(pricing.prompt),
      outputPerM: perM(pricing.completion),
      contextTokens: typeof m.context_length === 'number' ? m.context_length : null,
      modality: typeof arch.modality === 'string' ? arch.modality : null,
      inputModalities: strList(arch.input_modalities),
      outputModalities: strList(arch.output_modalities),
      created: typeof m.created === 'number' ? m.created : null,
    });
  }
  catalogCache = { at: Date.now(), models };
  return { ok: true, models };
}

// ─── read tools ────────────────────────────────────────────────────

const openrouter_rankings: BuiltinToolDef = {
  slug: 'openrouter_rankings',
  name: 'OpenRouter usage rankings',
  description:
    "Real-world model popularity: total tokens per model across OpenRouter, aggregated over the requested window (their public top-50 daily dataset). Returns `models` (slug + tokens, busiest first), `asOf`, and the required `attribution` line. Filter by `category` (e.g. 'programming') or `modality` to rank for a specific job. Use with `openrouter_benchmarks` when curating pools — usage says what people trust, benchmarks say what scores. Uses the owner's OpenRouter key.",
  inputSchema: {
    type: 'object',
    properties: {
      days: {
        type: 'integer',
        minimum: 1,
        maximum: 90,
        default: 14,
        description: 'Window length ending at the latest completed day.',
      },
      category: {
        type: 'string',
        description: "Usage category filter, e.g. 'programming', 'roleplay', 'marketing'.",
      },
      modality: {
        type: 'string',
        enum: ['text', 'image', 'image_output', 'audio', 'tool_calling'],
        description: 'Restrict to traffic of this modality.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        default: 20,
        description: 'Max models to return.',
      },
    },
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const refused = refuseTeamSurface(ctx);
    if (refused) return refused;
    const apiKey = await resolveOpenRouterKey(ctx.ownerId);
    if (!apiKey) return { ok: false, error: needKey() };
    const days = typeof input.days === 'number' ? input.days : 14;
    const limit = typeof input.limit === 'number' ? input.limit : 20;
    const end = new Date(Date.now() - 24 * 3600_000);
    const start = new Date(end.getTime() - (days - 1) * 24 * 3600_000);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const res = await orGet(
      '/datasets/rankings-daily',
      {
        start_date: iso(start),
        end_date: iso(end),
        category: str(input.category) || undefined,
        modality: str(input.modality) || undefined,
      },
      apiKey,
    );
    if (!res.ok) return { ok: false, error: res.error };
    const body = res.json as {
      data?: Array<{ model_permaslug?: string; total_tokens?: unknown }>;
      meta?: { as_of?: string };
    };
    const totals = new Map<string, number>();
    for (const row of body.data ?? []) {
      const slug = row.model_permaslug;
      if (!slug || slug === 'other') continue;
      totals.set(slug, (totals.get(slug) ?? 0) + num(row.total_tokens));
    }
    const models = [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([model, tokens]) => ({ model, tokens }));
    const asOf = body.meta?.as_of ?? new Date().toISOString();
    return {
      ok: true,
      output: {
        window: { start: iso(start), end: iso(end) },
        asOf,
        models,
        attribution: `Source: OpenRouter (openrouter.ai/rankings), as of ${asOf}.`,
      },
    };
  },
};

const openrouter_benchmarks: BuiltinToolDef = {
  slug: 'openrouter_benchmarks',
  name: 'OpenRouter benchmarks',
  description:
    "Benchmark scores for models, from OpenRouter's benchmarks dataset. `source` picks the shape: 'artificial-analysis' (composite intelligence/coding/agentic indices with pricing), 'design-arena' (ELO/win rates), 'openrouter' (their web-search + classic evals). Filter with `task_type` ('coding', 'intelligence', 'agentic', 'search'). Pair with `openrouter_rankings` when curating: scores + real usage together beat either alone. Uses the owner's OpenRouter key.",
  inputSchema: {
    type: 'object',
    properties: {
      source: {
        type: 'string',
        enum: ['artificial-analysis', 'design-arena', 'openrouter'],
        description: 'Which benchmark family to read.',
      },
      task_type: {
        type: 'string',
        enum: ['coding', 'intelligence', 'agentic', 'search'],
        description: 'Restrict to one task type.',
      },
      category: { type: 'string', description: 'Optional source-specific category filter.' },
      max_results: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        default: 25,
        description: 'Max rows to return.',
      },
    },
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const refused = refuseTeamSurface(ctx);
    if (refused) return refused;
    const apiKey = await resolveOpenRouterKey(ctx.ownerId);
    if (!apiKey) return { ok: false, error: needKey() };
    const maxResults = typeof input.max_results === 'number' ? input.max_results : 25;
    const res = await orGet(
      '/benchmarks',
      {
        source: str(input.source) || undefined,
        task_type: str(input.task_type) || undefined,
        category: str(input.category) || undefined,
        max_results: String(maxResults),
      },
      apiKey,
    );
    if (!res.ok) return { ok: false, error: res.error };
    const body = res.json as { data?: unknown[] };
    const rows = (Array.isArray(body.data) ? body.data : []).slice(0, maxResults);
    return { ok: true, output: { count: rows.length, rows } };
  },
};

const openrouter_task_classes: BuiltinToolDef = {
  slug: 'openrouter_task_classes',
  name: 'OpenRouter task classifications',
  description:
    'Market-share breakdown of OpenRouter traffic by task type (code generation, summarization, web search, …) over the last 7 days, including the top models per classification. The fastest way to see which models dominate a specific JOB — useful for the worker pools (summarizer, vision, …). Uses the owner’s OpenRouter key.',
  inputSchema: { type: 'object', properties: {} },
  handler: async (_input, ctx): Promise<ToolHandlerResult> => {
    const refused = refuseTeamSurface(ctx);
    if (refused) return refused;
    const apiKey = await resolveOpenRouterKey(ctx.ownerId);
    if (!apiKey) return { ok: false, error: needKey() };
    const res = await orGet('/classifications/task', { window: '7d' }, apiKey);
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, output: res.json as Record<string, unknown> };
  },
};

const model_catalog: BuiltinToolDef = {
  slug: 'model_catalog',
  name: 'Model catalog with pricing',
  description:
    "Look up models with pricing: OpenRouter's public catalog (slug, live input/output $ per 1M, context, modality, plus `inputModalities`/`outputModalities` — the output side is what separates an image READER from an image GENERATOR) PLUS Mantle's wired voice catalogs (grok-voice, whisper/gpt-4o transcribe, ElevenLabs, Deepgram, Gemini voices) which OpenRouter's list omits. THE source for slugs and pricing snapshots when writing entries with `model_pool_set` — each row's `provider` is the route to record. Voice rows have `kind` tts/stt and NULL pricing (billed per character/minute, not per token — leave the snapshot empty, never invent a rate). `q` searches name/slug; `ids` fetches exact slugs. Keyless; cached ~5 minutes.",
  inputSchema: {
    type: 'object',
    properties: {
      q: { type: 'string', description: "Substring match on slug or name, e.g. 'sonnet'." },
      ids: {
        type: 'array',
        items: { type: 'string' },
        description: "Exact slugs to fetch, e.g. ['anthropic/claude-sonnet-5'].",
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        default: 25,
        description: 'Max models to return.',
      },
    },
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const refused = refuseTeamSurface(ctx);
    if (refused) return refused;
    const res = await loadCatalog();
    if (!res.ok) return { ok: false, error: res.error };
    const q = str(input.q).trim().toLowerCase();
    const ids = Array.isArray(input.ids)
      ? new Set(input.ids.filter((v): v is string => typeof v === 'string'))
      : null;
    const limit = typeof input.limit === 'number' ? input.limit : 25;
    let models = [...res.models, ...voiceCatalogSupplement()];
    if (ids && ids.size > 0) models = models.filter((m) => ids.has(m.id));
    else if (q) {
      models = models.filter(
        (m) => m.id.toLowerCase().includes(q) || (m.name ?? '').toLowerCase().includes(q),
      );
    }
    return {
      ok: true,
      output: { total: models.length, models: models.slice(0, limit) },
    };
  },
};

// ─── write tools (the curated_models store) ────────────────────────

const POOL_HINT = `valid pools: ${MODEL_POOLS.map((p) => p.id).join(', ')}`;

const model_pool_list: BuiltinToolDef = {
  slug: 'model_pool_list',
  name: 'List curated model pools',
  description:
    'The curated pools and their current entries (name, vendor, per-provider routes, pricing snapshot, rating, note, order) plus each pool’s purpose. Read this FIRST when curating — pools the owner already filled reflect their judgment; say so before replacing entries. The owner sees the same data at /models/pools.',
  inputSchema: {
    type: 'object',
    properties: {
      pool: { type: 'string', description: "One pool id to read, e.g. 'agents'. Omit for all." },
    },
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const pool = str(input.pool).trim();
    if (pool && !MODEL_POOL_IDS.has(pool)) {
      return { ok: false, error: `unknown pool '${pool}' — ${POOL_HINT}` };
    }
    const where = pool
      ? and(eq(curatedModels.ownerId, ctx.ownerId), eq(curatedModels.pool, pool))
      : eq(curatedModels.ownerId, ctx.ownerId);
    const entries = await db
      .select()
      .from(curatedModels)
      .where(where)
      .orderBy(asc(curatedModels.pool), asc(curatedModels.position));
    const pools = MODEL_POOLS.filter((p) => !pool || p.id === pool);
    return {
      ok: true,
      output: {
        pools,
        entries: entries.map((e) => ({
          pool: e.pool,
          name: e.name,
          vendor: e.vendor,
          routes: e.routes,
          pricing: e.pricing,
          rating: e.rating,
          note: e.note,
          position: e.position,
        })),
      },
    };
  },
};

/**
 * Catalog-checked pool fit: does this entry's OpenRouter route actually do
 * what the pool needs? The reason this exists is the "Read images" trap — an
 * image GENERATOR (Nano Banana Pro, GPT Image) accepts images just like a
 * reader does, so a curator picking on names alone lands one in the vision
 * pool, where it bills image-generation tokens and returns a picture the
 * vision worker cannot parse. The catalog's `output_modalities` settles it.
 *
 * Fail-open: only a LOADED catalog that positively contradicts the pool
 * rejects. No OpenRouter route, an unknown slug, or an unreachable catalog
 * all return null — an outage must never block curation.
 */
async function poolFitIssue(pool: string, routes: CuratedRoute[]): Promise<string | null> {
  const route = routes.find((r) => r.provider === 'openrouter');
  if (!route) return null;
  const res = await loadCatalog();
  if (!res.ok) return null;
  const slug = route.model.trim().toLowerCase();
  const hit = res.models.find((m) => m.id.toLowerCase() === slug);
  if (!hit) return null;
  return poolModelIssue(pool, { input: hit.inputModalities, output: hit.outputModalities });
}

const model_pool_set: BuiltinToolDef = {
  slug: 'model_pool_set',
  name: 'Add or update a curated pool entry',
  description:
    "Upsert one model into a curated pool (matched by pool + name; existing entries are updated in place). `routes` is the model's slug per provider — always include the `openrouter` route, plus the direct-provider slug when it differs (e.g. anthropic 'claude-sonnet-5'). Copy `pricing` from `model_catalog` — it is a snapshot that keeps the $100 comparison working on direct-connected brains. Checked against the live catalog and REFUSED when the model cannot do the pool's job: read `outputModalities` first — one that outputs images is a GENERATOR, never a reader (the Read-images pool wants a capable text-out model that accepts pictures). Curation only: this changes the shortlist at /models/pools, never what any agent or worker runs.",
  inputSchema: {
    type: 'object',
    properties: {
      pool: { type: 'string', description: "Pool id, e.g. 'agents' or 'summarizer'." },
      name: { type: 'string', description: "Display name, e.g. 'Claude Sonnet 5'." },
      vendor: { type: 'string', description: "Model maker, e.g. 'Anthropic'." },
      routes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            provider: { type: 'string', description: "e.g. 'openrouter', 'anthropic', 'google'" },
            model: { type: 'string', description: 'The slug THAT provider uses for this model.' },
          },
          required: ['provider', 'model'],
        },
        minItems: 1,
        description: 'One row per provider route.',
      },
      input_per_m: { type: 'number', minimum: 0, description: 'USD per 1M input tokens.' },
      output_per_m: { type: 'number', minimum: 0, description: 'USD per 1M output tokens.' },
      rating: { type: 'integer', minimum: 1, maximum: 5, description: 'Curated quality rating.' },
      note: {
        type: 'string',
        description: "Short tier note, e.g. 'flagship' or 'gets the job done'.",
      },
      position: {
        type: 'integer',
        minimum: 0,
        description: 'Order in the pool (0 = top; convention: priciest first). Omit to append.',
      },
    },
    required: ['pool', 'name', 'routes'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const refused = refuseTeamSurface(ctx);
    if (refused) return refused;
    const pool = str(input.pool).trim();
    if (!MODEL_POOL_IDS.has(pool)) {
      return { ok: false, error: `unknown pool '${pool}' — ${POOL_HINT}` };
    }
    const name = str(input.name).trim();
    if (!name) return { ok: false, error: 'name is required — the display name of the model' };
    const routesIn = Array.isArray(input.routes) ? input.routes : [];
    const routes: CuratedRoute[] = [];
    for (const r of routesIn) {
      const rr = (r ?? {}) as Record<string, unknown>;
      const provider = str(rr.provider).trim().toLowerCase();
      const model = str(rr.model).trim();
      if (provider && model) routes.push({ provider, model });
    }
    if (routes.length === 0) {
      return {
        ok: false,
        error:
          "routes must contain at least one {provider, model} — e.g. {provider:'openrouter', model:'anthropic/claude-sonnet-5'}",
      };
    }
    const misfit = await poolFitIssue(pool, routes);
    if (misfit) return { ok: false, error: `${name} does not belong in '${pool}': ${misfit}` };
    const inP = typeof input.input_per_m === 'number' ? input.input_per_m : null;
    const outP = typeof input.output_per_m === 'number' ? input.output_per_m : null;
    const pricing: CuratedPricing | null =
      inP == null && outP == null
        ? null
        : {
            inputPerM: inP,
            outputPerM: outP,
            currency: 'USD',
            capturedAt: new Date().toISOString(),
            source: 'openrouter',
          };
    const vendor = str(input.vendor).trim() || null;
    const rating = typeof input.rating === 'number' ? input.rating : null;
    const note = str(input.note).trim() || null;

    const [existing] = await db
      .select()
      .from(curatedModels)
      .where(
        and(
          eq(curatedModels.ownerId, ctx.ownerId),
          eq(curatedModels.pool, pool),
          eq(curatedModels.name, name),
        ),
      )
      .limit(1);
    if (existing) {
      const [row] = await db
        .update(curatedModels)
        .set({
          routes,
          ...(vendor != null ? { vendor } : {}),
          ...(pricing != null ? { pricing } : {}),
          ...(rating != null ? { rating } : {}),
          ...(note != null ? { note } : {}),
          ...(typeof input.position === 'number' ? { position: input.position } : {}),
          updatedAt: new Date(),
        })
        .where(eq(curatedModels.id, existing.id))
        .returning({ id: curatedModels.id });
      return { ok: true, output: { ok: true, updated: true, id: row?.id, pool, name } };
    }
    const siblings = await db
      .select({ position: curatedModels.position })
      .from(curatedModels)
      .where(and(eq(curatedModels.ownerId, ctx.ownerId), eq(curatedModels.pool, pool)));
    const position =
      typeof input.position === 'number'
        ? input.position
        : siblings.reduce((m, r) => Math.max(m, r.position + 1), 0);
    const [row] = await db
      .insert(curatedModels)
      .values({ ownerId: ctx.ownerId, pool, position, name, vendor, routes, pricing, rating, note })
      .returning({ id: curatedModels.id });
    return { ok: true, output: { ok: true, inserted: true, id: row?.id, pool, name } };
  },
};

const model_pool_remove: BuiltinToolDef = {
  slug: 'model_pool_remove',
  name: 'Remove a curated pool entry',
  description:
    'Remove one model from a curated pool, matched by pool + exact name (find both with `model_pool_list`). Only the shortlist changes — nothing that currently uses the model is affected.',
  inputSchema: {
    type: 'object',
    properties: {
      pool: { type: 'string', description: 'Pool id the entry lives in.' },
      name: { type: 'string', description: 'Exact display name of the entry.' },
    },
    required: ['pool', 'name'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const refused = refuseTeamSurface(ctx);
    if (refused) return refused;
    const pool = str(input.pool).trim();
    const name = str(input.name).trim();
    const deleted = await db
      .delete(curatedModels)
      .where(
        and(
          eq(curatedModels.ownerId, ctx.ownerId),
          eq(curatedModels.pool, pool),
          eq(curatedModels.name, name),
        ),
      )
      .returning({ id: curatedModels.id });
    if (deleted.length === 0) {
      return {
        ok: false,
        error: `no entry '${name}' in pool '${pool}' — list the exact names with model_pool_list`,
      };
    }
    return { ok: true, output: { ok: true, removed: name, pool } };
  },
};

export const CURATION_TOOLS: readonly BuiltinToolDef[] = [
  openrouter_rankings,
  openrouter_benchmarks,
  openrouter_task_classes,
  model_catalog,
  model_pool_list,
  model_pool_set,
  model_pool_remove,
];
