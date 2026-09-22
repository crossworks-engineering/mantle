/**
 * Pool re-curation — the DB + network half.
 *
 * Gathers the three public evidence sets, asks {@link planCuration} what the
 * pools should hold, and (only under `apply`) writes the answer into
 * `curated_models`. Lives in `lib/` rather than the script so the nightly cron
 * runs the SAME definition — a report that exists only inside a script gets
 * marked schedulable and then never runs once, which is exactly what happened
 * to `deps-drift`.
 *
 * Evidence, and what happens when a piece of it is missing:
 *
 *   catalog     keyless, always available. Without it there is no plan at all,
 *               so a failed fetch aborts rather than curating from nothing.
 *   benchmarks  needs the owner's OpenRouter key (Data API). Absent ⇒ ranking
 *               falls back to usage alone, and the run SAYS so. Silently
 *               curating on half the evidence would look identical to curating
 *               on all of it.
 *   usage       same key, same degradation.
 *
 * Read-only unless `apply` is set. The default is a plan you can read.
 */
import { db, curatedModels, eq, type CuratedRoute } from '@mantle/db';
import { resolveOpenRouterKey } from '@mantle/tools';
import { errorMessage } from '@mantle/std';
import { MANIFEST_WORKERS, PERSONA_MANIFEST } from '../system-manifest';
import {
  planCuration,
  type BenchRow,
  type CatalogRow,
  type CurationPlan,
  type UsageRow,
} from './curate-pools';

const OR_BASE = 'https://openrouter.ai/api/v1';
const TIMEOUT_MS = 25_000;

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
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      return { ok: false, error: `OpenRouter ${path} returned ${res.status}` };
    }
    return { ok: true, json: await res.json() };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

function perM(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n * 1_000_000 : null;
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * The full catalog — `output_modalities=all` is load-bearing. Without it this
 * is the text-out slice only (429 of 601 rows on 2026-09-22): most image
 * generators, every video model, all 18 speech and all 21 transcription
 * engines are simply absent, which leaves image_gen/tts/stt uncuratable.
 */
export async function fetchCatalog(): Promise<
  { ok: true; rows: CatalogRow[] } | { ok: false; error: string }
> {
  const res = await orGet('/models', { output_modalities: 'all' });
  if (!res.ok) return res;
  const data = (res.json as { data?: unknown[] }).data ?? [];
  const rows: CatalogRow[] = [];
  for (const raw of data) {
    const m = raw as Record<string, unknown>;
    if (typeof m.id !== 'string') continue;
    const pricing = (m.pricing ?? {}) as Record<string, unknown>;
    const arch = (m.architecture ?? {}) as Record<string, unknown>;
    const contextTokens = typeof m.context_length === 'number' ? m.context_length : null;
    // Only token-billed rows get a per-1M price. A published context window is
    // the tell: windowless voice routes price at up to $360,000 per "1M"
    // because their `pricing.prompt` is a per-MINUTE audio rate. These numbers
    // land in a pool snapshot and drive the "$100 buys…" comparison, so a
    // wrong-unit figure poisons it — null keeps the never-invent-a-rate rule.
    const tokenBilled = (contextTokens ?? 0) > 0;
    rows.push({
      id: m.id,
      name: typeof m.name === 'string' ? m.name : null,
      inputPerM: tokenBilled ? perM(pricing.prompt) : null,
      outputPerM: tokenBilled ? perM(pricing.completion) : null,
      contextTokens,
      inputModalities: strList(arch.input_modalities),
      outputModalities: strList(arch.output_modalities),
    });
  }
  return { ok: true, rows };
}

/** Artificial Analysis composite scores. Needs the owner's OpenRouter key. */
export async function fetchBenchmarks(apiKey: string): Promise<BenchRow[]> {
  const res = await orGet(
    '/benchmarks',
    { source: 'artificial-analysis', task_type: 'intelligence', max_results: '100' },
    apiKey,
  );
  if (!res.ok) return [];
  const data = (res.json as { data?: unknown[] }).data ?? [];
  const out: BenchRow[] = [];
  for (const raw of data) {
    const r = raw as Record<string, unknown>;
    if (typeof r.model_permaslug !== 'string') continue;
    const idx = Number(r.intelligence_index);
    out.push({
      model_permaslug: r.model_permaslug,
      intelligence_index: Number.isFinite(idx) ? idx : null,
    });
  }
  return out;
}

/** Real OpenRouter traffic over the trailing window. Needs the same key. */
export async function fetchUsage(apiKey: string, days = 14): Promise<UsageRow[]> {
  const end = new Date(Date.now() - 24 * 3600_000);
  const start = new Date(end.getTime() - (days - 1) * 24 * 3600_000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const res = await orGet(
    '/datasets/rankings-daily',
    { start_date: iso(start), end_date: iso(end) },
    apiKey,
  );
  if (!res.ok) return [];
  const data =
    (res.json as { data?: Array<{ model_permaslug?: string; total_tokens?: unknown }> }).data ?? [];
  const totals = new Map<string, number>();
  for (const row of data) {
    const slug = row.model_permaslug;
    if (!slug || slug === 'other') continue;
    const n = Number(row.total_tokens);
    totals.set(slug, (totals.get(slug) ?? 0) + (Number.isFinite(n) ? n : 0));
  }
  return [...totals.entries()].map(([model, tokens]) => ({ model, tokens }));
}

export type CuratePoolsResult = {
  plan: CurationPlan;
  /** Evidence we could not reach, and why. Always stated: a plan built on the
   *  catalog alone looks exactly like one built on all three sources. */
  degraded: string[];
  /** Rows written. Zero unless `apply` was set. */
  written: number;
  /** Rows deleted because the new plan does not include them. */
  removed: number;
};

export type CuratePoolsOpts = {
  /** Write the plan into `curated_models`. Default false — plan only. */
  apply?: boolean;
  /** Whose pools. Required for apply; a plan alone needs no owner. */
  ownerId?: string;
};

/**
 * Compute the plan, and under `apply` make `curated_models` match it.
 *
 * Apply is a REPLACE of the manifest-owned shortlist, not a merge: the pools
 * are a ranked list, and merging a fresh ranking into a stale one yields an
 * order that is neither. Everything the owner sees at /models/pools is
 * regenerable from evidence, which is why replacing is safe here and would
 * not be for, say, an agent's prompt.
 */
export async function runCuratePools(opts: CuratePoolsOpts = {}): Promise<CuratePoolsResult> {
  const degraded: string[] = [];

  const catalog = await fetchCatalog();
  if (!catalog.ok) {
    throw new Error(`curate-pools: cannot read the OpenRouter catalog (${catalog.error})`);
  }

  let benchmarks: BenchRow[] = [];
  let usage: UsageRow[] = [];
  const apiKey = opts.ownerId ? await resolveOpenRouterKey(opts.ownerId) : null;
  if (apiKey) {
    [benchmarks, usage] = await Promise.all([fetchBenchmarks(apiKey), fetchUsage(apiKey)]);
    if (!benchmarks.length) degraded.push('benchmarks: the Data API returned nothing');
    if (!usage.length) degraded.push('usage rankings: the Data API returned nothing');
  } else {
    degraded.push(
      'no OpenRouter key for this owner — benchmarks and usage rankings were skipped, ' +
        'so the ranking is catalog-only (price and modality, no quality signal)',
    );
  }

  const current = opts.ownerId
    ? (
        await db
          .select({
            pool: curatedModels.pool,
            name: curatedModels.name,
            routes: curatedModels.routes,
          })
          .from(curatedModels)
          .where(eq(curatedModels.ownerId, opts.ownerId))
      ).map((r) => ({ pool: r.pool, name: r.name, routes: r.routes as CuratedRoute[] }))
    : [];

  const plan = planCuration({
    catalog: catalog.rows,
    benchmarks,
    usage,
    current,
    required: manifestDefaults(),
  });

  if (!opts.apply) return { plan, degraded, written: 0, removed: 0 };
  if (!opts.ownerId) throw new Error('curate-pools: apply needs an owner id');

  const ownerId = opts.ownerId;
  const removed = current.length;
  await db.transaction(async (tx) => {
    await tx.delete(curatedModels).where(eq(curatedModels.ownerId, ownerId));
    if (!plan.entries.length) return;
    await tx.insert(curatedModels).values(
      plan.entries.map((e) => ({
        ownerId,
        pool: e.pool,
        position: e.position,
        name: e.name,
        vendor: e.vendor,
        routes: e.routes,
        pricing: e.pricing,
        rating: e.rating,
        note: e.note,
      })),
    );
  });

  return { plan, degraded, written: plan.entries.length, removed };
}

/**
 * The models the system manifest seeds, keyed by the pool that offers them.
 *
 * These are forced into their pool whatever the ranking says. A picker that
 * lists ten alternatives to a default it does not itself offer is confusing at
 * best and, when the owner then "picks the recommended one", impossible.
 * Worker kinds and pool ids share one vocabulary, so the mapping is direct.
 */
function manifestDefaults(): Record<string, string[]> {
  const out: Record<string, string[]> = { agents: [PERSONA_MANIFEST.model] };
  for (const w of MANIFEST_WORKERS) {
    // The runner-queue worker template resolves its model from whichever
    // responder runs it, so there is no id to offer.
    if (!w.model || w.model === 'inherit') continue;
    // Only OpenRouter-routed defaults belong in a pool: the catalog is where
    // the pool's prices and modality facts come from.
    if (w.provider !== 'openrouter') continue;
    (out[w.kind] ??= []).push(w.model);
  }
  return out;
}
