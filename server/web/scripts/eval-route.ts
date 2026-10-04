/**
 * eval:route — passage retrieval scored PER QUESTION TYPE, so a routing rule
 * that wins on one type and loses on another shows it (the context routing
 * plan, docs/recall-eval.md "eval:route").
 *
 * A case file is a JSON array of typed cases (scripts/eval/route-score.ts:
 * `{id, query, type, flags?, profile?, expectChunks? | expectNodeIds? |
 * expectNodeTitleIncludes?}`). Gold sets name one brain's nodes, so they
 * live OUTSIDE the repo, like every gold set here.
 *
 * Rulesets (`--rulesets=`, comma list; the FIRST is the reference the others
 * are compared and gated against):
 *
 *   vector       searchChunks without query text: the vector arm alone.
 *   hybrid       searchChunks with the query text: what `search_chunks`
 *                returns with the decider off.
 *   auto         the responder's auto-context passages: the hybrid pool of
 *                chunk_limit + 4, the 0.65 cutoff, the chunk_limit cut
 *                (selectChunkHits) under the shipped keyword rule
 *                (KEYWORD_PASSAGE_RULE). What reaches the prompt. No
 *                fact-source promotion: an eval set has no facts.
 *                `auto:off`, `auto:exempt`, `auto:slots` pin the rule.
 *   scored       `search_chunks` with Jev: the hybrid pool (--pool, else the
 *                brain's passage_scoring pool), scored, ordered and cut as
 *                `live` would, whatever the use's mode.
 *   auto-scored  auto-context with passage_scoring before the cut (v0.237.4
 *                with a pool set): pool, score, order, then the cutoff and
 *                the chunk_limit cut. `auto-scored:<rule>` pins the rule.
 *
 * Per ruleset and type: n, R@1, R@k (k = 10; auto rulesets send at most
 * chunk_limit, so R@k is "in the prompt"), MRR, p50/p90 latency of the
 * ruleset's own work (the query embedding is not counted) and model cost.
 *
 * Cost. Every query is embedded once; `--vectors=<file.json>` caches the
 * vectors ({caseId: number[]}), so a repeat run embeds nothing. The scored
 * rulesets cost one Jev fan-out per case (about USD 0.0007 per request of
 * 25 passages, an estimate from request counts). The run prints its cost.
 * Manual only: never wire this to a cron or a trigger.
 *
 * Usage (DATABASE_URL + ALLOWED_USER_ID point at a brain or a throwaway copy):
 *   pnpm -C server/web eval:route --cases=<file> [--rulesets=hybrid,auto,scored]
 *     [--vectors=<file>] [--pool=50] [--chunk-limit=8] [--k=10]
 *     [--types=T2,T3] [--case=<id>] [--baseline=<run.json>] [--target=T3]
 *     [--max-loss=2] [--out=<run.json>] [--json]
 *
 * Read-only for the corpus. The decider records its own usage (ai_workers
 * counters, trace rows) like any call.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { embed } from '@mantle/embeddings';
import { searchChunks, searchChunksExplained, type ChunkHit } from '@mantle/search';
import {
  MAX_PASSAGES_PER_REQUEST,
  applyPassageScores,
  decisionUseEnabled,
  passageScoringPool,
  scorePassages,
} from '@mantle/decisions';
import {
  KEYWORD_PASSAGE_RULE,
  keywordPassages,
  selectChunkHits,
  type KeywordPassageRule,
} from '@mantle/runtime/agent';
import { env } from '@mantle/config';
import {
  QUESTION_TYPES,
  comparePaired,
  gateFailures,
  goldRankOf,
  parseRouteCases,
  summarizeByType,
  type CaseResult,
  type Hit,
  type QuestionType,
  type RouteCase,
  type TypeDelta,
  type TypeSummary,
} from './eval/route-score';

/** Jev's list price per request of up to 25 passages (docs/recall-eval.md). */
const JEV_USD_PER_REQUEST = 0.0007;

type Ctx = {
  ownerId: string;
  c: RouteCase;
  vec: number[];
  k: number;
  chunkLimit: number;
  pool: number | null;
};
type RulesetRun = { hits: Hit[]; requests: number };
type Ruleset = { name: string; describe: string; run: (x: Ctx) => Promise<RulesetRun> };

const toHits = (rows: readonly ChunkHit[]): Hit[] =>
  rows.map((r) => ({ nodeId: r.nodeId, title: r.nodeTitle, ordinal: r.ordinal }));

/** The hybrid pool, scored by Jev and ordered as `live` orders it. */
async function scoredPool(
  x: Ctx,
  limit: number,
): Promise<{ rows: Awaited<ReturnType<typeof searchChunksExplained>>['hits']; requests: number }> {
  const use = await decisionUseEnabled(x.ownerId, 'passage_scoring');
  if (!use) throw new Error('the scored rulesets need the decider with passage_scoring on');
  const poolSize = passageScoringPool(x.pool !== null ? { pool: x.pool } : use, limit);
  const { hits: found } = await searchChunksExplained({
    ownerId: x.ownerId,
    embedding: x.vec,
    q: x.c.query,
    limit: poolSize,
    excludeSystemOrigin: true,
  });
  const key = (h: ChunkHit) => `${h.nodeId}:${h.ordinal}`;
  const scoring = await scorePassages(
    x.ownerId,
    x.c.query,
    found.map((h) => ({ id: key(h), title: h.nodeTitle, heading: h.headingPath, text: h.text })),
  );
  return {
    rows: scoring ? applyPassageScores(found, key, scoring).kept : found,
    // A repeat of the same question and pool is served from the decider's
    // in-process cache: no request, no cost.
    requests: scoring?.cached ? 0 : Math.ceil(found.length / MAX_PASSAGES_PER_REQUEST),
  };
}

export const RULESETS: Record<string, Ruleset> = {
  vector: {
    name: 'vector',
    describe: 'vector arm alone, top k',
    run: async (x) => ({
      hits: toHits(await searchChunks({ ownerId: x.ownerId, embedding: x.vec, limit: x.k })),
      requests: 0,
    }),
  },
  hybrid: {
    name: 'hybrid',
    describe: 'search_chunks, decider off: hybrid top k',
    run: async (x) => ({
      hits: toHits(
        await searchChunks({ ownerId: x.ownerId, embedding: x.vec, q: x.c.query, limit: x.k }),
      ),
      requests: 0,
    }),
  },
  scored: {
    name: 'scored',
    describe: 'search_chunks with Jev over the pool, top k',
    run: async (x) => {
      const r = await scoredPool(x, x.k);
      return { hits: toHits(r.rows.slice(0, x.k)), requests: r.requests };
    },
  },
};

/** The responder's auto-context cut under a keyword rule (select.ts). */
const autoRun =
  (rule: KeywordPassageRule) =>
  async (x: Ctx): Promise<RulesetRun> => {
    const { hits: pool } = await searchChunksExplained({
      ownerId: x.ownerId,
      embedding: x.vec,
      q: x.c.query,
      limit: x.chunkLimit + 4,
      excludeSystemOrigin: true,
    });
    const sel = selectChunkHits(pool, x.chunkLimit, undefined, keywordPassages(rule));
    return { hits: selectedHits(sel.hits), requests: 0 };
  };
const autoScoredRun =
  (rule: KeywordPassageRule) =>
  async (x: Ctx): Promise<RulesetRun> => {
    const r = await scoredPool(x, x.chunkLimit);
    const sel = selectChunkHits(r.rows, x.chunkLimit, undefined, keywordPassages(rule));
    return { hits: selectedHits(sel.hits), requests: r.requests };
  };

// `auto` / `auto-scored` run the shipped keyword rule; `:off`, `:exempt` and
// `:slots` pin one, so a rule change is gated against the rule before it.
const RULE_NOTE: Record<KeywordPassageRule, string> = {
  off: 'cutoff on every passage',
  exempt: 'keyword passages skip the cutoff',
  slots: 'keyword passages skip the cutoff and take tail slots',
};
for (const rule of [KEYWORD_PASSAGE_RULE, 'off', 'exempt', 'slots'] as const) {
  const tag = rule === KEYWORD_PASSAGE_RULE && !RULESETS.auto ? '' : `:${rule}`;
  RULESETS[`auto${tag}`] = {
    name: `auto${tag}`,
    describe: `auto-context: hybrid chunk_limit+4, cutoff, chunk_limit cut; ${RULE_NOTE[rule]}`,
    run: autoRun(rule),
  };
  RULESETS[`auto-scored${tag}`] = {
    name: `auto-scored${tag}`,
    describe: `auto-context with Jev before the cut; ${RULE_NOTE[rule]}`,
    run: autoScoredRun(rule),
  };
}

function selectedHits(
  rows: ReadonlyArray<{ nodeId: string; title: string; ordinal?: number }>,
): Hit[] {
  return rows.map((h) => ({ nodeId: h.nodeId, title: h.title, ordinal: h.ordinal }));
}

type Args = {
  casesPath: string;
  rulesets: string[];
  vectorsPath: string | null;
  pool: number | null;
  chunkLimit: number;
  k: number;
  types: QuestionType[] | null;
  onlyCase: string | null;
  baselinePath: string | null;
  target: QuestionType | null;
  maxLoss: number;
  outPath: string | null;
  json: boolean;
};

function parseArgs(argv: string[]): Args {
  const a: Args = {
    casesPath: '',
    rulesets: ['hybrid', 'auto'],
    vectorsPath: null,
    pool: null,
    chunkLimit: 8,
    k: 10,
    types: null,
    onlyCase: null,
    baselinePath: null,
    target: null,
    maxLoss: 2,
    outPath: null,
    json: false,
  };
  const val = (s: string) => s.slice(s.indexOf('=') + 1);
  for (const s of argv) {
    if (s.startsWith('--cases=')) a.casesPath = val(s);
    else if (s.startsWith('--rulesets=')) a.rulesets = val(s).split(',').filter(Boolean);
    else if (s.startsWith('--vectors=')) a.vectorsPath = val(s);
    else if (s.startsWith('--pool=')) a.pool = Number(val(s));
    else if (s.startsWith('--chunk-limit=')) a.chunkLimit = Number(val(s));
    else if (s.startsWith('--k=')) a.k = Number(val(s));
    else if (s.startsWith('--types=')) a.types = val(s).split(',') as QuestionType[];
    else if (s.startsWith('--case=')) a.onlyCase = val(s);
    else if (s.startsWith('--baseline=')) a.baselinePath = val(s);
    else if (s.startsWith('--target=')) a.target = val(s) as QuestionType;
    else if (s.startsWith('--max-loss=')) a.maxLoss = Number(val(s));
    else if (s.startsWith('--out=')) a.outPath = val(s);
    else if (s === '--json') a.json = true;
    else throw new Error(`unknown argument ${s}`);
  }
  if (!a.casesPath) throw new Error('--cases=<file> is required');
  for (const r of a.rulesets) {
    if (!RULESETS[r])
      throw new Error(`unknown ruleset ${r} (known: ${Object.keys(RULESETS).join(', ')})`);
  }
  if (a.pool !== null && !(a.pool >= 1)) throw new Error('--pool must be a positive number');
  return a;
}

type RunFile = {
  at: string;
  cases: string;
  k: number;
  chunkLimit: number;
  pool: number | null;
  rulesets: Record<string, { describe: string; summary: TypeSummary[]; cases: CaseResult[] }>;
  cost: { embedded: number; jevRequests: number; usd: number };
};

const pct = (x: number) => `${Math.round(x * 100)}%`.padStart(5);

function printSummary(name: string, describe: string, rows: TypeSummary[], k: number): void {
  console.log(`\n${name}: ${describe}`);
  console.log(
    `  ${'type'.padEnd(8)}${'n'.padStart(5)}${'R@1'.padStart(6)}${`R@${k}`.padStart(6)}${'MRR'.padStart(7)}${'p50 ms'.padStart(9)}${'p90 ms'.padStart(9)}${'USD'.padStart(10)}`,
  );
  for (const r of rows) {
    console.log(
      `  ${String(r.type).padEnd(8)}${String(r.n).padStart(5)}${pct(r.r1).padStart(6)}${pct(r.rk).padStart(6)}${r.mrr.toFixed(3).padStart(7)}${String(r.p50).padStart(9)}${String(r.p90).padStart(9)}${r.usd.toFixed(4).padStart(10)}`,
    );
  }
}

function printDeltas(label: string, deltas: TypeDelta[], fails: string[], k: number): void {
  console.log(`\n${label} (paired cases; won/lost)`);
  console.log(
    `  ${'type'.padEnd(8)}${'n'.padStart(5)}${`R@${k} +/-`.padStart(11)}${'R@1 +/-'.padStart(10)}`,
  );
  for (const d of deltas) {
    console.log(
      `  ${String(d.type).padEnd(8)}${String(d.n).padStart(5)}${`+${d.wonK}/-${d.lostK}`.padStart(11)}${`+${d.won1}/-${d.lost1}`.padStart(10)}`,
    );
  }
  console.log(fails.length ? `  GATE: FAIL. ${fails.join('; ')}` : '  GATE: pass');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ownerId = env('ALLOWED_USER_ID');
  if (!ownerId) throw new Error('ALLOWED_USER_ID is required');
  let cases = parseRouteCases(JSON.parse(readFileSync(args.casesPath, 'utf8')));
  if (args.onlyCase) cases = cases.filter((c) => c.id === args.onlyCase);
  if (args.types) cases = cases.filter((c) => args.types!.includes(c.type));
  if (cases.length === 0) throw new Error('no cases selected');

  // Query vectors: cached per case id, so a repeat run embeds nothing.
  const vectors: Record<string, number[]> =
    args.vectorsPath && existsSync(args.vectorsPath)
      ? (JSON.parse(readFileSync(args.vectorsPath, 'utf8')) as Record<string, number[]>)
      : {};
  let embedded = 0;
  for (const c of cases) {
    if (vectors[c.id]) continue;
    vectors[c.id] = await embed(ownerId, c.query.slice(0, 2000));
    embedded++;
  }
  if (embedded > 0 && args.vectorsPath) writeFileSync(args.vectorsPath, JSON.stringify(vectors));

  const run: RunFile = {
    at: new Date().toISOString(),
    cases: args.casesPath,
    k: args.k,
    chunkLimit: args.chunkLimit,
    pool: args.pool,
    rulesets: {},
    cost: { embedded, jevRequests: 0, usd: 0 },
  };
  for (const name of args.rulesets) {
    const rs = RULESETS[name]!;
    const results: CaseResult[] = [];
    for (const c of cases) {
      const t0 = performance.now();
      const out = await rs.run({
        ownerId,
        c,
        vec: vectors[c.id]!,
        k: args.k,
        chunkLimit: args.chunkLimit,
        pool: args.pool,
      });
      const ms = Math.round(performance.now() - t0);
      const rank = goldRankOf(c, out.hits.slice(0, args.k));
      run.cost.jevRequests += out.requests;
      results.push({
        id: c.id,
        type: c.type,
        profile: c.profile ?? 'mixed',
        rank,
        ms,
        usd: out.requests * JEV_USD_PER_REQUEST,
      });
    }
    run.rulesets[name] = {
      describe: rs.describe,
      summary: summarizeByType(results, args.k),
      cases: results,
    };
  }
  run.cost.usd = Math.round(run.cost.jevRequests * JEV_USD_PER_REQUEST * 1e4) / 1e4;
  if (args.outPath) writeFileSync(args.outPath, JSON.stringify(run, null, 2));
  if (args.json) {
    console.log(JSON.stringify(run, null, 2));
    return;
  }

  const profiles = [...new Set(cases.map((c) => c.profile ?? 'mixed'))];
  const types = [...new Set(cases.map((c) => c.type))];
  console.log(
    `eval:route  ${cases.length} cases (${profiles.join(', ')}), types ${types
      .map((t) => `${t} ${QUESTION_TYPES[t]} (${cases.filter((c) => c.type === t).length})`)
      .join('; ')}`,
  );
  for (const name of args.rulesets) {
    const r = run.rulesets[name]!;
    printSummary(name, r.describe, r.summary, args.k);
  }
  const [refName, ...others] = args.rulesets;
  const gate = { maxLoss: args.maxLoss, ...(args.target ? { target: args.target } : {}) };
  for (const name of others) {
    const d = comparePaired(run.rulesets[refName!]!.cases, run.rulesets[name]!.cases, args.k);
    printDeltas(`${name} vs ${refName}`, d, gateFailures(d, gate), args.k);
  }
  if (args.baselinePath) {
    const base = JSON.parse(readFileSync(args.baselinePath, 'utf8')) as RunFile;
    for (const name of args.rulesets) {
      const b = base.rulesets[name];
      if (!b) continue;
      const d = comparePaired(b.cases, run.rulesets[name]!.cases, args.k);
      printDeltas(`${name} vs baseline ${base.at}`, d, gateFailures(d, gate), args.k);
    }
  }
  console.log(
    `\ncost: ${embedded} queries embedded, ${run.cost.jevRequests} Jev requests, about USD ${run.cost.usd.toFixed(4)}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
