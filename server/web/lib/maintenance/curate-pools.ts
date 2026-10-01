/**
 * Pool re-curation — rebuild the curated model shortlists from live evidence.
 *
 * WHY THIS EXISTS: the curated pools are a snapshot of somebody's judgement on
 * one day, and nothing ages them. The shipped template was curated 2026-08-22;
 * by 2026-09-22 two of its 97 entries pointed at models OpenRouter had
 * delisted (a `Free` combo therefore picked a reflector that 404s), four
 * carried prices off by up to 5x, and seven vendors had shipped auto-updating
 * `~vendor/x-latest` aliases that no pool offered. None of that was visible:
 * a stale shortlist looks exactly like a considered one.
 *
 * `pool-fit` already asks whether a curated entry can do its pool's job, and
 * `pinned-model-drift` asks whether a model a row POINTS AT still exists.
 * Neither proposes a replacement, because both are deliberately report-only.
 * This is the third question — what SHOULD be in each pool today — and it is
 * the one that needs an answer rather than a finding.
 *
 * ── Deterministic, not a language model ─────────────────────────────────────
 *
 * The Curator specialist can do this conversationally, and for a one-off
 * re-curation it does it well. But a judgement that must be re-made every few
 * weeks should be reproducible: same evidence in, same shortlist out, and a
 * diff a human can read before it is applied. So the ranking here is arithmetic
 * over three public datasets — OpenRouter's catalog (what exists, what it
 * costs, what it can do), Artificial Analysis benchmarks (what scores), and
 * OpenRouter's usage rankings (what people actually trust with real traffic).
 * Benchmarks alone over-rate models nobody ships; usage alone over-rates
 * whatever is cheapest. The blend is the whole point.
 *
 * Report-only by construction: this module computes a PLAN. Writing it is the
 * caller's decision, behind `--apply`.
 */

import { MODEL_POOLS, poolModelIssue, type ModelPoolDef } from '@mantle/client-types/model-pools';

/** One row of OpenRouter's catalog, as `model_catalog` already parses it. */
export type CatalogRow = {
  id: string;
  name: string | null;
  inputPerM: number | null;
  outputPerM: number | null;
  contextTokens: number | null;
  inputModalities: readonly string[];
  outputModalities: readonly string[];
};

/** One benchmark row (Artificial Analysis, via OpenRouter's dataset). */
export type BenchRow = {
  /** Dated permaslug, e.g. `x-ai/grok-4.7-20260916`. */
  model_permaslug: string;
  intelligence_index: number | null;
};

/** One usage row from OpenRouter's public rankings. */
export type UsageRow = { model: string; tokens: number };

/** A curated entry, in exactly the shape the template and the export use. */
export type PlannedEntry = {
  pool: string;
  position: number;
  name: string;
  vendor: string | null;
  routes: { provider: string; model: string }[];
  pricing: {
    inputPerM: number | null;
    outputPerM: number | null;
    currency: 'USD';
    capturedAt: string;
    source: string;
  } | null;
  rating: number | null;
  note: string | null;
};

export type PoolPlan = {
  pool: string;
  label: string;
  entries: PlannedEntry[];
  /** Entries in the CURRENT pool whose OpenRouter route no longer exists.
   *  Reported separately because a delisted slug is breakage, not staleness. */
  dropped: { name: string; model: string; reason: string }[];
};

export type CurationPlan = {
  capturedAt: string;
  pools: PoolPlan[];
  /** Every planned entry, flat and position-ordered — the template shape. */
  entries: PlannedEntry[];
};

// ── Evidence normalisation ───────────────────────────────────────────────────

/**
 * Strip the trailing date a benchmark/usage permaslug carries.
 * `x-ai/grok-4.7-20260916` → `x-ai/grok-4.7`, and `deepseek/…-flash-20260731`
 * → `deepseek/…-flash`. Variant suffixes (`:free`, `:batch`) are kept, because
 * a free tier is a different row with different economics.
 */
export function undatedSlug(slug: string): string {
  return slug.replace(/-\d{8}(?=$|:)/, '');
}

/** The vendor half of a slug, alias tilde removed. `~x-ai/grok-latest` → `x-ai`. */
export function vendorOf(id: string): string {
  return id.replace(/^~/, '').split('/')[0] ?? '';
}

/** Display names for the vendor prefixes OpenRouter uses. Falls back to the
 *  prefix itself, which is readable enough (`upstage`, `krea`). */
const VENDOR_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  'x-ai': 'xAI',
  deepseek: 'DeepSeek',
  'z-ai': 'Z.ai',
  moonshotai: 'MoonshotAI',
  meta: 'Meta',
  mistralai: 'Mistral',
  qwen: 'Qwen',
  nvidia: 'NVIDIA',
  perplexity: 'Perplexity',
  typesafe: 'TypeSafe',
  microsoft: 'Microsoft',
  minimax: 'MiniMax',
  tencent: 'Tencent',
  xiaomi: 'Xiaomi',
  'fish-audio': 'Fish Audio',
  deepgram: 'Deepgram',
  'black-forest-labs': 'Black Forest Labs',
  'bytedance-seed': 'ByteDance',
  recraft: 'Recraft',
};

export function vendorLabel(id: string): string {
  const v = vendorOf(id);
  return VENDOR_LABELS[v] ?? v;
}

/** OpenRouter marks an auto-updating alias with a leading `~`. */
export function isAlias(id: string): boolean {
  return id.startsWith('~');
}

/**
 * Blended $ per 1M at a 75/25 input/output mix — the same weighting
 * `blendedPerM` in model-combos.ts uses, so the ordering this produces and the
 * combos computed over it agree about which entry is dearest. Null when the
 * model is not token-billed (per-minute audio routes), never 0: a free model
 * genuinely costs 0 and must sort below a priced one.
 */
export function blended(inputPerM: number | null, outputPerM: number | null): number | null {
  if (inputPerM == null && outputPerM == null) return null;
  return 0.75 * (inputPerM ?? outputPerM ?? 0) + 0.25 * (outputPerM ?? inputPerM ?? 0);
}

// ── Ranking ──────────────────────────────────────────────────────────────────

/**
 * A pool's COST POSTURE — the one thing the pool definitions cannot express
 * and the ranking cannot do without.
 *
 * `agents` and the worker pools have identical modality contracts (text in,
 * text out), so a fit check alone ranks them identically and every worker pool
 * comes back holding the same ten frontier models. That is precisely wrong:
 * the extractor reads EVERYTHING ingested, so its pool is a cheap-workhorse
 * shortlist where a $10/1M flagship is a mistake, not a top pick. The first
 * version of this file shipped that bug, and it was invisible until the plan
 * was printed side by side.
 *
 *   premium     price is not the constraint; rank on quality alone.
 *   workhorse   high call volume; rank on quality PER DOLLAR and refuse
 *               anything above the ceiling.
 *   specialist  a narrow field (generators, voice engines, search, decisions)
 *               where no general benchmark applies; price is the signal.
 */
type PoolTier = 'premium' | 'workhorse' | 'specialist';

const POOL_TIER: Record<string, PoolTier> = {
  agents: 'premium',
  extractor: 'workhorse',
  summarizer: 'workhorse',
  reflector: 'workhorse',
  narrator: 'workhorse',
  suggester: 'workhorse',
  document: 'workhorse',
  vision: 'workhorse',
  image_gen: 'specialist',
  tts: 'specialist',
  stt: 'specialist',
  search: 'specialist',
  search_advanced: 'specialist',
  decider: 'specialist',
};

/**
 * Blended $/1M ceiling for a workhorse pool. Set just above Claude Haiku
 * (blended $2.00), which is the shipped template's own idea of the dearest
 * model that still belongs on a workhorse list — so the ceiling encodes a
 * judgement already made rather than inventing a new one. Sonnet-class models
 * blend to $4.00 and are correctly excluded.
 */
const WORKHORSE_CEILING_PER_M = 2.5;

/** How many entries each pool carries. Matches the shipped template's own
 *  shape: ten for the high-traffic text pools, fewer where the field is
 *  genuinely narrow (two search tiers exist; one decision model exists). */
const POOL_SIZE: Record<string, number> = {
  agents: 10,
  extractor: 10,
  summarizer: 10,
  reflector: 10,
  narrator: 10,
  suggester: 10,
  document: 7,
  vision: 6,
  image_gen: 6,
  tts: 7,
  stt: 7,
  search: 3,
  search_advanced: 3,
  decider: 2,
};

/** Ids that are never curatable, whatever their modalities say. */
function isExcluded(id: string): boolean {
  // `:batch` is the same model on a delayed queue — a billing mode, not a
  // choice, and picking it for a live turn would stall every reply.
  if (id.endsWith(':batch')) return true;
  // The meta-routers' modalities are the union over everything they might
  // route to, so they pass every pool's fit check and belong in none.
  if (id.startsWith('openrouter/auto')) return true;
  return false;
}

/**
 * `search` and `search_advanced` are not "a text model that is good" — they
 * need a model with live web retrieval built in, which the catalog's modality
 * fields cannot express. Perplexity's Sonar family is the set Mantle's
 * `web_search` tool is written against, so the pool is restricted by vendor.
 */
function poolAllows(pool: string, id: string, row: CatalogRow): boolean {
  if (pool === 'search' || pool === 'search_advanced') return vendorOf(id) === 'perplexity';
  // The voice pools need an ENGINE. `poolModelIssue` deliberately fails open
  // here — it is a save-time guard that must never block an owner's judgement
  // during a catalog outage — so a chat model that merely ACCEPTS audio passes
  // it. That is how `~google/gemini-pro-latest` ranked top of Transcribe: it
  // takes audio in and answers in text, which is a conversation about a
  // recording, not a transcript. Curation can afford the stricter rule.
  const out = row.outputModalities;
  if (pool === 'tts') return out.includes('speech') || out.includes('audio');
  if (pool === 'stt') return out.includes('transcription') || out.includes('audio');
  return true;
}

/** Roughly: is this the strong tier or the cheap tier of the search family? */
function searchTierFits(pool: string, id: string): boolean {
  const pro = id.includes('-pro') || id.includes('reasoning') || id.includes('deep-research');
  return pool === 'search_advanced' ? pro : !pro;
}

type Scored = {
  row: CatalogRow;
  /** 0..1 from the benchmark intelligence index, or null when unbenchmarked. */
  bench: number | null;
  /** 0..1 from real OpenRouter traffic, or null when the model is unranked. */
  usage: number | null;
  /** The raw intelligence index behind `bench`, for the stored note. */
  benchIndex: number | null;
  /** True when the evidence came from the family rather than this exact id —
   *  i.e. this is an alias scored on what it currently resolves to. */
  inherited: boolean;
  /** This id is a system-manifest default, forced in regardless of rank. */
  shipped?: boolean;
  /** Place in the pool's RANK ordering, before the display sort by price. */
  rankIndex?: number;
  blendedPerM: number | null;
};

/**
 * Evidence for one id, falling back to the best-scoring member of its family.
 *
 * This exists for the aliases. `~x-ai/grok-latest` appears in no benchmark and
 * no usage ranking — those datasets key on dated permaslugs of concrete
 * releases — so scored on its own id every alias came back with no signal at
 * all, sorted last, and rated ★1. That is exactly backwards: an alias IS the
 * vendor's current model, so it deserves that model's evidence. Inheriting
 * within the family is the narrowest way to say so, and it is marked
 * `inherited` so the stored note does not overclaim a direct measurement.
 */
function evidenceFor(
  id: string,
  benchBySlug: Map<string, number>,
  usageBySlug: Map<string, number>,
  familyBest: Map<string, { bench: number | null; usage: number | null }>,
): { bench: number | null; usage: number | null; inherited: boolean } {
  const bench = benchBySlug.get(id) ?? null;
  const usage = usageBySlug.get(id) ?? null;
  if (bench != null || usage != null) return { bench, usage, inherited: false };
  // ONLY an alias may inherit. A concrete release must stand on its own
  // evidence: `openai/gpt-4` shares the `openai/gpt` family with GPT-5.5, so
  // letting it borrow a sibling's score handed a 2023 model a ★★★★ rating —
  // and then the price tie-break, which prefers the dearer of two equals, put
  // it at the TOP of the agents pool at $30/$60 per 1M. An alias is the same
  // model as its target; an old release is not its successor.
  if (!isAlias(id)) return { bench: null, usage: null, inherited: false };
  const fam = familyBest.get(`${vendorOf(id)}::${familyKey(id)}`);
  if (!fam) return { bench: null, usage: null, inherited: false };
  return { bench: fam.bench, usage: fam.usage, inherited: true };
}

/**
 * Combine benchmark score and real usage into one 0..1 rank.
 *
 * Usage can only LIFT. The obvious version — blend the two 60/40 — has a
 * perverse consequence: a model with a strong benchmark and modest traffic
 * scores BELOW an identical model nobody has ranked, because the missing
 * signal is treated as neutral while a real one is treated as a low mark.
 * `~x-ai/grok-latest` carried the highest benchmark in the agents pool and
 * came out ★3 that way. Being measured must not be a penalty.
 *
 * So the benchmark sets the floor and usage closes some of the distance to 1:
 * a well-used model beats an equally-scored unused one, a heavily-used model
 * with a modest benchmark still climbs (real traffic is evidence a benchmark
 * cannot capture), and nothing is ever worse off for having been counted.
 * With no benchmark at all, usage is the whole signal.
 */
export function combineRank(bench: number | null, usage: number | null): number {
  if (bench == null) return usage ?? 0;
  if (usage == null) return bench;
  const USAGE_LIFT = 0.4;
  return bench + (1 - bench) * USAGE_LIFT * usage;
}

/**
 * 1..5 from an entry's place in its OWN pool's ranking.
 *
 * Absolute bands do not work here, and shipping them proved it twice. Scored
 * against the whole catalog every curated model rated ★1, because none of them
 * appear in a general benchmark; scored against the benchmark leader they ALL
 * rated ★5, because a shortlist contains nothing but top models. Either way the
 * stars said the same thing about every row, which is to say nothing.
 *
 * A shortlist rating is a comparison WITHIN the list — it is what the original
 * hand-curated template meant by giving Opus 5 a 5 and a budget flash model a
 * 3 — so that is what this computes. The bands are coarse because the ordering
 * is the real signal and the stars are a glance at it.
 */
function poolRating(index: number, total: number): number {
  if (total <= 1) return 5;
  const share = index / (total - 1);
  if (share <= 0.2) return 5;
  if (share <= 0.45) return 4;
  if (share <= 0.75) return 3;
  return 2;
}

/** The one-line note stored with the entry, stating the evidence behind it. */
function noteFor(s: Scored): string {
  const bits: string[] = [];
  if (s.shipped) bits.push('the shipped default for this pool');
  if (isAlias(s.row.id)) bits.push('auto-updating alias — tracks this vendor’s current model');
  if (s.benchIndex != null) {
    bits.push(
      s.inherited
        ? `intelligence index ${s.benchIndex} (the release it currently resolves to)`
        : `intelligence index ${s.benchIndex}`,
    );
  }
  if (s.usage != null && s.usage >= 0.5) bits.push('busier than most of the ranked field');
  if (s.blendedPerM === 0) bits.push('free tier: rate-limited, use as a fallback not a default');
  if (s.row.contextTokens && s.row.contextTokens >= 1_000_000) bits.push('1M+ context');
  return bits.length ? bits.join('; ') : 'fits the pool; no benchmark or usage signal';
}

// ── The plan ─────────────────────────────────────────────────────────────────

export type PlanInput = {
  catalog: readonly CatalogRow[];
  benchmarks: readonly BenchRow[];
  usage: readonly UsageRow[];
  /** What the pools hold today — used only to report delisted entries. */
  current: readonly { pool: string; name: string; routes: { provider: string; model: string }[] }[];
  /**
   * Models that MUST appear in a pool whatever the ranking says, keyed by pool
   * id — in practice the ids the system manifest seeds.
   *
   * Without this the shortlist can omit the very model a fresh install runs on:
   * `google/gemini-3.5-flash-lite` carries no benchmark row and no usage row,
   * so it scored zero and lost every worker slot to models with evidence, and
   * the picker then offered ten alternatives to a default it did not list. A
   * shipped default is a product decision that outranks the arithmetic.
   */
  required?: Readonly<Record<string, readonly string[]>>;
  /** Stamped onto every pricing snapshot. Injected so tests are deterministic. */
  capturedAt?: string;
  pools?: readonly ModelPoolDef[];
};

/**
 * Build the full curation plan. Pure: same input, same output, no clock, no
 * network. The caller prints it, and only `--apply` turns it into writes.
 */
export function planCuration(input: PlanInput): CurationPlan {
  const capturedAt = input.capturedAt ?? new Date().toISOString();
  const pools = input.pools ?? MODEL_POOLS;

  // Evidence, keyed by undated slug so a dated permaslug finds its catalog row.
  const benchBySlug = new Map<string, number>();
  for (const b of input.benchmarks) {
    if (b.intelligence_index == null) continue;
    const key = undatedSlug(b.model_permaslug);
    // Several effort tiers of one model appear; keep the best score it can reach.
    const prev = benchBySlug.get(key);
    if (prev == null || b.intelligence_index > prev) benchBySlug.set(key, b.intelligence_index);
  }
  const maxBench = Math.max(1, ...benchBySlug.values());

  const usageTokens = new Map<string, number>();
  for (const u of input.usage) {
    const key = undatedSlug(u.model);
    usageTokens.set(key, Math.max(usageTokens.get(key) ?? 0, u.tokens));
  }
  // PERCENTILE, not a share of the leader.
  //
  // Token counts span orders of magnitude — the busiest model on OpenRouter
  // does ~17 trillion tokens a week and the fiftieth does ~1 trillion. Dividing
  // by the maximum crushed everything below the leader to near zero, and since
  // `combineRank` blends 60/40 when both signals exist, a heavily-used model
  // scored WORSE than an identical one nobody had measured: `~x-ai/grok-latest`
  // carried the highest benchmark in the agents pool (46.4) and came out ★3,
  // because inheriting a small usage fraction dragged a 0.87 rank to 0.54.
  // Being measured must never be a penalty. A percentile says what the raw
  // count means — "busier than 80% of the ranked field" — and is immune to the
  // scale.
  const usageBySlug = new Map<string, number>();
  const ordered = [...usageTokens.entries()].sort((a, b) => b[1] - a[1]);
  ordered.forEach(([slug], i) => {
    usageBySlug.set(slug, ordered.length === 1 ? 1 : 1 - i / (ordered.length - 1));
  });
  const maxUsage = 1;

  // Best evidence seen anywhere in each family, so an alias can inherit it.
  const familyBest = new Map<string, { bench: number | null; usage: number | null }>();
  for (const [key, source] of [
    [benchBySlug, 'bench'] as const,
    [usageBySlug, 'usage'] as const,
  ].map(([m, s]) => [m, s] as const)) {
    for (const [slug, value] of key) {
      const fk = `${vendorOf(slug)}::${familyKey(slug)}`;
      const cur = familyBest.get(fk) ?? { bench: null, usage: null };
      if (source === 'bench') cur.bench = Math.max(cur.bench ?? 0, value);
      else cur.usage = Math.max(cur.usage ?? 0, value);
      familyBest.set(fk, cur);
    }
  }

  const live = new Set(input.catalog.map((m) => m.id));
  const poolPlans: PoolPlan[] = [];

  for (const pool of pools) {
    const size = POOL_SIZE[pool.id] ?? 6;

    const tier = POOL_TIER[pool.id] ?? 'specialist';

    // 1. Everything the catalog says can do this pool's job.
    const eligible: Scored[] = [];
    for (const row of input.catalog) {
      if (isExcluded(row.id)) continue;
      if (!poolAllows(pool.id, row.id, row)) continue;
      if (
        (pool.id === 'search' || pool.id === 'search_advanced') &&
        !searchTierFits(pool.id, row.id)
      )
        continue;
      const issue = poolModelIssue(pool.id, {
        input: row.inputModalities,
        output: row.outputModalities,
      });
      if (issue) continue;
      const perM = blended(row.inputPerM, row.outputPerM);
      // A workhorse pool refuses a flagship outright. Ranking alone will not
      // do it: a $10/1M model with a top benchmark beats a $0.30 one on
      // quality every time, and the extractor would then be curated to read
      // every ingested document on the dearest model available.
      if (tier === 'workhorse' && perM != null && perM > WORKHORSE_CEILING_PER_M) continue;
      const ev = evidenceFor(row.id, benchBySlug, usageBySlug, familyBest);
      eligible.push({
        row,
        bench: ev.bench == null ? null : ev.bench / maxBench,
        usage: ev.usage == null ? null : ev.usage / maxUsage,
        benchIndex: ev.bench,
        inherited: ev.inherited,
        blendedPerM: perM,
      });
    }

    // 2. Rank, then keep at most one entry per vendor-family so a pool is not
    //    six flavours of one model. On a workhorse pool the ranking is quality
    //    PER DOLLAR: the point of that pool is throughput, and a model twice as
    //    good for five times the money is the wrong pick there and the right
    //    one on `agents`.
    const score = (x: Scored): number => {
      const q = combineRank(x.bench, x.usage);
      if (tier !== 'workhorse') return q;
      // Quality per dollar — which, at a price of zero, is just quality, so a
      // free tier swept to the top of every workhorse pool. The template's own
      // note has always said what they are: "rate-limited, no vendor SLA, use
      // as a fallback not a default". Charging them a notional floor price
      // keeps them on the list and off position 0.
      const FREE_TIER_FLOOR = 0.15;
      const perM = x.blendedPerM === 0 || x.blendedPerM == null ? FREE_TIER_FLOOR : x.blendedPerM;
      return q / (1 + perM);
    };
    eligible.sort((a, b) => {
      const d = score(b) - score(a);
      if (d !== 0) return d;
      // Tie-break toward the alias: it is the same model and it does not go
      // stale, which is the entire reason the vendor publishes it.
      if (isAlias(a.row.id) !== isAlias(b.row.id)) return isAlias(a.row.id) ? -1 : 1;
      // Then dearest first among equals, with unpriced rows last — a curator's
      // "no price" is a per-minute voice route, not a free model.
      if (a.blendedPerM == null) return b.blendedPerM == null ? 0 : 1;
      if (b.blendedPerM == null) return -1;
      return b.blendedPerM - a.blendedPerM;
    });
    const takenFamily = new Set<string>();
    const picked: Scored[] = [];
    for (const s of eligible) {
      if (picked.length >= size) break;
      const family = `${vendorOf(s.row.id)}::${familyKey(s.row.id)}`;
      if (takenFamily.has(family)) continue;
      takenFamily.add(family);
      picked.push(s);
    }

    // 2b. Force in the shipped defaults, displacing the weakest pick if the
    //     pool is already full. A default the picker does not offer is a bug
    //     the ranking cannot see.
    const requiredIds = new Set(input.required?.[pool.id] ?? []);
    for (const id of requiredIds) {
      // Already earned its place on merit — just mark it, so the note says so
      // whether or not forcing was needed.
      const already = picked.find((p) => p.row.id === id);
      if (already) {
        already.shipped = true;
        continue;
      }
      // Drop whatever already holds this family. Otherwise forcing the shipped
      // default in put `~x-ai/grok-latest` directly beside the pinned
      // `x-ai/grok-4.7` it currently resolves to — the same model twice, which
      // is exactly what the one-per-family rule exists to prevent. The forced
      // id wins, because a shipped default outranks the arithmetic.
      const family = `${vendorOf(id)}::${familyKey(id)}`;
      const clash = picked.findIndex(
        (p) => `${vendorOf(p.row.id)}::${familyKey(p.row.id)}` === family,
      );
      if (clash >= 0) picked.splice(clash, 1);
      const row = input.catalog.find((r) => r.id === id);
      if (!row) continue;
      const ev = evidenceFor(id, benchBySlug, usageBySlug, familyBest);
      const forced: Scored = {
        row,
        bench: ev.bench == null ? null : ev.bench / maxBench,
        usage: ev.usage == null ? null : ev.usage / maxUsage,
        benchIndex: ev.bench,
        inherited: ev.inherited,
        blendedPerM: blended(row.inputPerM, row.outputPerM),
        shipped: true,
      };
      if (picked.length >= size) picked.pop();
      picked.push(forced);
    }

    // 3. The pool is left in RANK order, best first.
    //
    //    It used to be re-sorted by price, on the old "priciest first"
    //    convention — which held only while price tracked quality. It stopped
    //    holding: the shortlist now carries cheap models with strong evidence,
    //    so a price-ordered list showed stars scattered up and down it and read
    //    as though the ratings were noise. Ordering by rank makes the list say
    //    one thing, and the price is still on every row for the cost question.
    //
    //    Safe for the combos: for a PRICED pool they read price directly
    //    (`best-advanced` takes the dearest, `cheapest` the lowest), never
    //    position. Position matters only for the unpriced voice pools, where
    //    their fallback already assumes a curator ordered it best→budget —
    //    which is now literally true rather than hoped for.
    // Re-rank AFTER the forced defaults joined: they are pushed onto the end of
    // the list, so ranking by arrival put `~x-ai/grok-latest` last in the
    // agents pool and `google/gemini-3.5-flash-lite` last in every worker pool
    // — the shipped defaults, rated worst, on the strength of nothing but
    // insertion order.
    // Shipped defaults lead, then everything else by score.
    //
    // Ranking them like any other row put `~x-ai/grok-latest` LAST in the
    // agents pool at ★2. The arithmetic was right and the outcome was still
    // wrong: Grok 4.7 shipped six days before this ran, so it had no traffic
    // yet, while rivals a fraction behind it on the benchmark got a usage lift
    // straight past it. Any ranking that leans on adoption will do that to a
    // new model, and the pool would have told the owner that the model their
    // brain actually runs is the worst option on the list.
    //
    // A default is a recommendation we have already made. It leads, the way the
    // recommended card leads the onboarding list, and the rest is ranked.
    picked.sort((a, b) => {
      if (!!a.shipped !== !!b.shipped) return a.shipped ? -1 : 1;
      return score(b) - score(a);
    });
    picked.forEach((p, i) => {
      p.rankIndex = i;
    });

    const entries: PlannedEntry[] = picked.map((s, i) => ({
      pool: pool.id,
      position: i,
      name: s.row.name ?? s.row.id,
      vendor: vendorLabel(s.row.id),
      routes: [{ provider: 'openrouter', model: s.row.id }],
      pricing:
        s.row.inputPerM == null && s.row.outputPerM == null
          ? null
          : {
              inputPerM: s.row.inputPerM,
              outputPerM: s.row.outputPerM,
              currency: 'USD',
              capturedAt,
              source: 'openrouter',
            },
      rating: poolRating(s.rankIndex ?? i, picked.length),
      note: noteFor(s),
    }));

    // 4. What the pool holds today that the catalog no longer lists. Only
    //    OpenRouter routes are checkable — a direct-provider slug
    //    (`claude-opus-5`) is out of scope, not a finding.
    const dropped: PoolPlan['dropped'] = [];
    for (const cur of input.current) {
      if (cur.pool !== pool.id) continue;
      const or = cur.routes.find((r) => r.provider === 'openrouter');
      if (!or || live.has(or.model)) continue;
      dropped.push({
        name: cur.name,
        model: or.model,
        reason: 'not in the live OpenRouter catalog — a turn on it would 404',
      });
    }

    poolPlans.push({ pool: pool.id, label: pool.label, entries, dropped });
  }

  return { capturedAt, pools: poolPlans, entries: poolPlans.flatMap((p) => p.entries) };
}

/**
 * The version-free stem of a slug, used to collapse `grok-4.5` / `grok-4.6` /
 * `grok-4.7` / `~grok-latest` into one family so a pool is not six flavours of
 * the same model. Variant suffixes stay: `:free` is a different economic row.
 */
export function familyKey(id: string): string {
  const [base, variant] = id.replace(/^~/, '').split(':');
  const stem = (base ?? '')
    .replace(/-latest$/, '')
    .replace(/-\d+(?:\.\d+)*$/, '')
    .replace(/-(preview|exp)$/, '');
  return variant ? `${stem}:${variant}` : stem;
}

/** One line for the maintenance run row. Reporting drift is not a failure, so
 *  this summarises rather than throws — same contract as the drift sweeps. */
export function summariseCuration(plan: CurationPlan): string {
  const delisted = plan.pools.reduce((n, p) => n + p.dropped.length, 0);
  return (
    `${plan.entries.length} entries planned across ${plan.pools.length} pools — ` +
    `${delisted} currently-curated entr${delisted === 1 ? 'y is' : 'ies are'} delisted`
  );
}
