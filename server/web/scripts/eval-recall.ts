/**
 * Recall eval harness — measures whether the brain actually surfaces the right
 * thing for a natural-language query. This is the "is the librarian any good?"
 * meter the audit called for: a gold-set of (query → expected node) pairs run
 * through the REAL retrieval code, scored as recall@k + MRR.
 *
 * It deliberately measures four retrievers side by side so you can see both the
 * current reality and the headroom:
 *
 *   prod    — loadConversationContext() exactly as Saskia runs it (content hits
 *             capped at memory_config.content_hit_limit, 0.6 cosine cutoff). This
 *             is "what actually reaches the prompt." The truest current number.
 *   vector  — the same per-node vector ranker, but top-RANK_K with NO cutoff, so
 *             you can see where the gold node ranks even when prod's cap drops it.
 *   fts     — searchNodes() (Postgres full-text). What the `search` tool uses.
 *   chunks  — searchChunks() (passage-level vector). What `search_chunks` uses.
 *   rrf     — Reciprocal-Rank Fusion of vector+fts+chunks. A baseline for the
 *             hybrid retrieval the audit recommends (Tier-0 #1). If rrf beats
 *             vector here, that's your evidence the upgrade is worth building.
 *
 * Passage retrievers (scored on the exact chunk when a case names one in
 * `expectChunks`, and on the document as well):
 *
 *   passage         — searchChunks() hybrid, the call `search_chunks` and the
 *                     responder's auto-context make. The real agent path.
 *   passage-vector  — the same call with no query text (vector arm alone).
 *   passage-keyword — the keyword arm alone (`arms: 'keyword'`).
 *   passage-scored  — what the `search_chunks` tool returns: the hybrid pool,
 *                     scored by the decider's `passage_scoring` use when the
 *                     brain has it on (pool and threshold from its settings).
 *                     Costs one decision call per case; same as `passage`
 *                     when the use is off.
 *
 * Usage:
 *   ALLOWED_USER_ID=<uuid> pnpm -C server/web eval:recall
 *   ALLOWED_USER_ID=<uuid> pnpm -C server/web eval:recall --rank-k=30
 *   ALLOWED_USER_ID=<uuid> pnpm -C server/web eval:recall --case=sermon-potter-clay
 *   ALLOWED_USER_ID=<uuid> pnpm -C server/web eval:recall --baseline=scripts/eval/last-run.json
 *   ALLOWED_USER_ID=<uuid> pnpm -C server/web eval:recall --json    # machine-readable only
 *   ALLOWED_USER_ID=<uuid> pnpm -C server/web eval:recall --retrievers=passage,passage-vector,passage-keyword
 *
 * `--retrievers=` picks a subset. Without `prod` no responder agent is needed,
 * so the passage retrievers also run against a bare corpus copy (the scale
 * curve in docs/recall-eval.md does exactly that).
 *
 * Reads gold cases from scripts/eval/recall-cases.json. Writes a snapshot to
 * scripts/eval/last-run.json (override with --out=). Pass --baseline= to print
 * per-metric deltas against a prior snapshot — the regression gate when you
 * change retrieval.
 *
 * Read-only: it never writes to the brain. Safe to run against prod.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db, agents, nodes, type Agent } from '@mantle/db';
import { embed } from '@mantle/embeddings';
import { searchNodes, searchChunks } from '@mantle/search';
import {
  applyPassageScores,
  decisionUseEnabled,
  passageScoringPool,
  scorePassages,
} from '@mantle/decisions';
import { loadConversationContext } from '@mantle/runtime/agent';
import { env } from '@mantle/config';

const HERE = dirname(fileURLToPath(import.meta.url));
// `fts` = legacy FTS-only searchNodes (the pre-(b) baseline, kept as a reference
// for why we changed it). `search` = the shipped hybrid searchNodes the `search`
// / `search_nodes` tools now use (vector-led + FTS booster).
const RETRIEVERS = [
  'prod',
  'vector',
  'fts',
  'search',
  'chunks',
  'rrf',
  'passage',
  'passage-vector',
  'passage-keyword',
  'passage-scored',
] as const;
type Retriever = (typeof RETRIEVERS)[number];
const PASSAGE_RETRIEVERS: readonly Retriever[] = [
  'passage',
  'passage-vector',
  'passage-keyword',
  'passage-scored',
];
const K_VALUES = [1, 3, 5, 10] as const;

type GoldCase = {
  id: string;
  query: string;
  expectNodeIds?: string[];
  expectNodeTitleIncludes?: string[];
  expectFactIncludes?: string[];
  /** Titles that should NOT appear in the prompt window — bulk/marketing the
   *  salience down-weight is meant to keep out. Drives the pollution metric. */
  avoidTitleIncludes?: string[];
  /** Passage-level gold: the chunk(s) that answer the query. Any listed
   *  ordinal counts (overlapping chunks can hold the same answer). */
  expectChunks?: Array<{ nodeId: string; ordinals: number[] }>;
  /** Free label for a per-group breakdown (e.g. paraphrase / verse / trap). */
  group?: string;
  note?: string;
};

/** One retrieved candidate, normalised across every retriever. Passage
 *  retrievers also carry the chunk ordinal. */
type Candidate = { id: string; title: string; ordinal?: number };

type Args = {
  rankK: number;
  casesPath: string;
  outPath: string;
  baselinePath: string | null;
  onlyCase: string | null;
  json: boolean;
  retrievers: Retriever[];
  /** Result size for the passage retrievers: 10 = the `search_chunks` default,
   *  so the pool sizing (5x the limit) matches what an agent gets. */
  passageLimit: number;
};

function parseArgs(argv: string[]): Args {
  const out: Args = {
    rankK: 20,
    casesPath: resolve(HERE, 'eval/recall-cases.json'),
    outPath: resolve(HERE, 'eval/last-run.json'),
    baselinePath: null,
    onlyCase: null,
    json: false,
    retrievers: [...RETRIEVERS],
    passageLimit: 10,
  };
  for (const a of argv) {
    if (a.startsWith('--rank-k=')) {
      const n = parseInt(a.slice('--rank-k='.length), 10);
      if (!Number.isNaN(n) && n > 0) out.rankK = n;
    } else if (a.startsWith('--cases=')) {
      out.casesPath = resolve(process.cwd(), a.slice('--cases='.length));
    } else if (a.startsWith('--out=')) {
      out.outPath = resolve(process.cwd(), a.slice('--out='.length));
    } else if (a.startsWith('--baseline=')) {
      out.baselinePath = resolve(process.cwd(), a.slice('--baseline='.length));
    } else if (a.startsWith('--case=')) {
      out.onlyCase = a.slice('--case='.length);
    } else if (a === '--json') {
      out.json = true;
    } else if (a.startsWith('--retrievers=')) {
      const want = a.slice('--retrievers='.length).split(',');
      const bad = want.filter((w) => !(RETRIEVERS as readonly string[]).includes(w));
      if (bad.length) throw new Error(`unknown retriever(s): ${bad.join(', ')}`);
      out.retrievers = RETRIEVERS.filter((r) => want.includes(r));
    } else if (a.startsWith('--passage-limit=')) {
      const n = parseInt(a.slice('--passage-limit='.length), 10);
      if (!Number.isNaN(n) && n > 0) out.passageLimit = n;
    }
  }
  return out;
}

/** A candidate matches the gold if its id is expected OR its title contains an
 *  expected substring (case-insensitive). Title match keeps cases authorable and
 *  resilient, id match keeps them precise. */
function isGold(c: Candidate, gc: GoldCase): boolean {
  const ids = gc.expectNodeIds ?? [];
  if (ids.includes(c.id)) return true;
  const title = c.title.toLowerCase();
  return (gc.expectNodeTitleIncludes ?? []).some((s) => title.includes(s.toLowerCase()));
}

/** 1-based rank of the first gold candidate, or 0 if none within the list. */
function goldRank(list: Candidate[], gc: GoldCase): number {
  for (let i = 0; i < list.length; i++) if (isGold(list[i]!, gc)) return i + 1;
  return 0;
}

/** 1-based rank of the first candidate that is a gold PASSAGE, or 0. */
function passageRank(list: Candidate[], gc: GoldCase): number {
  const want = gc.expectChunks ?? [];
  for (let i = 0; i < list.length; i++) {
    const c = list[i]!;
    if (want.some((w) => w.nodeId === c.id && w.ordinals.includes(c.ordinal ?? -1))) return i + 1;
  }
  return 0;
}

/** A candidate is "junk" if its title matches an avoid substring (bulk/marketing
 *  the salience down-weight should keep out of the prompt). */
function isJunk(c: Candidate, gc: GoldCase): boolean {
  const title = c.title.toLowerCase();
  return (gc.avoidTitleIncludes ?? []).some((s) => title.includes(s.toLowerCase()));
}

/** Reciprocal-Rank Fusion. Standard k=60. Higher score = better. */
function fuseRRF(lists: Candidate[][], k = 60): Candidate[] {
  const score = new Map<string, number>();
  const title = new Map<string, string>();
  for (const list of lists) {
    list.forEach((c, i) => {
      score.set(c.id, (score.get(c.id) ?? 0) + 1 / (k + i + 1));
      if (!title.has(c.id)) title.set(c.id, c.title);
    });
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => ({ id, title: title.get(id) ?? '' }));
}

/** The per-node vector ranker — mirrors loadConversationContext's content-hit
 *  query (same filters), but top-RANK_K with NO 0.6 cutoff so we can see rank. */
async function vectorNodes(
  ownerId: string,
  queryVec: number[],
  limit: number,
): Promise<Candidate[]> {
  const vec = JSON.stringify(queryVec);
  const rows = await db
    .select({ id: nodes.id, title: nodes.title })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        sql`${nodes.embedding} is not null`,
        sql`not (${nodes.tags} @> ARRAY['conversation-digest']::text[])`,
        sql`${nodes.type} <> 'telegram_message'`,
      ),
    )
    .orderBy(sql`${nodes.embedding} <=> ${vec}::vector`)
    .limit(limit);
  return rows.map((r) => ({ id: r.id, title: r.title }));
}

/** Dedup a list to first-occurrence (best rank) per node id. */
function dedup(list: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const c of list) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

type CaseResult = {
  id: string;
  query: string;
  group: string | null;
  /** Document-level rank per retriever (0 = missed; absent = not run). */
  ranks: Partial<Record<Retriever, number>>;
  /** Passage-level rank for the passage retrievers, on cases with expectChunks. */
  passageRanks: Partial<Record<Retriever, number>>;
  /** Wall time of the hybrid passage search (the agent path), ms. */
  passageMs: number | null;
  /** Wall time of the scored passage search (search + decision), ms. */
  scoredMs: number | null;
  /** Distinct documents in each passage retriever's result. */
  passageDocs: Partial<Record<Retriever, number>>;
  /** prod-only: did an expected fact substring appear in the facts Saskia saw? */
  factHit: boolean | null;
  /** For avoid-cases: did bulk/marketing junk reach the prompt window? null when
   *  the case has no avoid list. Measured on prod (the actual prompt) + search. */
  prodJunk: boolean | null;
  searchJunk: boolean | null;
};

async function runCase(
  gc: GoldCase,
  agent: Agent | null,
  ownerId: string,
  args: Args,
): Promise<CaseResult> {
  const { rankK } = args;
  const want = new Set(args.retrievers);
  const queryVec = await embed(ownerId, gc.query.slice(0, 2000));
  const lists: Partial<Record<Retriever, Candidate[]>> = {};

  let ctx: Awaited<ReturnType<typeof loadConversationContext>> | null = null;
  if (want.has('prod') && agent) {
    // prod: exactly what Saskia assembles (content hits capped + cutoff applied).
    ctx = await loadConversationContext({ ownerId, agent, inboundText: gc.query });
    // prod = everything that actually reaches the prompt as a content reference:
    // node-level content hits first, then any node a chunk passage surfaced (the
    // auto-chunk retrieval can recover a node whose whole-node embedding ranked
    // low but a section matched).
    lists.prod = dedup([
      ...ctx.contentHits.map((h) => ({ id: h.nodeId, title: h.title })),
      ...ctx.chunkHits.map((h) => ({ id: h.nodeId, title: h.title })),
    ]);
  }

  // vector / fts / search / chunks at RANK_K.
  if (want.has('vector') || want.has('rrf'))
    lists.vector = await vectorNodes(ownerId, queryVec, rankK);
  if (want.has('fts') || want.has('rrf')) {
    const ftsRows = await searchNodes({ ownerId, q: gc.query, limit: rankK }); // legacy FTS-only
    lists.fts = ftsRows.map((r) => ({ id: r.id, title: r.title }));
  }
  if (want.has('search')) {
    const searchRows = await searchNodes({
      ownerId,
      q: gc.query,
      limit: rankK,
      queryEmbedding: queryVec, // the shipped hybrid path
    });
    lists.search = searchRows.map((r) => ({ id: r.id, title: r.title }));
  }
  if (want.has('chunks') || want.has('rrf')) {
    const chunkRows = await searchChunks({ ownerId, embedding: queryVec, limit: rankK });
    lists.chunks = dedup(chunkRows.map((r) => ({ id: r.nodeId, title: r.nodeTitle })));
  }
  if (want.has('rrf')) lists.rrf = fuseRRF([lists.vector!, lists.fts!, lists.chunks!]);

  // Passage retrievers: the chunk list as the agent gets it (NOT deduped, so
  // a passage rank is a real position in the tool result).
  const passageArgs = {
    ownerId,
    embedding: queryVec,
    limit: args.passageLimit,
  };
  const passageLists: Partial<Record<Retriever, Candidate[]>> = {};
  const toCands = (rows: Awaited<ReturnType<typeof searchChunks>>): Candidate[] =>
    rows.map((r) => ({ id: r.nodeId, title: r.nodeTitle, ordinal: r.ordinal }));
  let passageMs: number | null = null;
  if (want.has('passage')) {
    const t0 = performance.now();
    passageLists.passage = toCands(await searchChunks({ ...passageArgs, q: gc.query }));
    passageMs = Math.round(performance.now() - t0);
  }
  if (want.has('passage-vector'))
    passageLists['passage-vector'] = toCands(await searchChunks(passageArgs));
  let scoredMs: number | null = null;
  if (want.has('passage-scored')) {
    // The tool's path (packages/tools/src/builtins-search.ts), live mode only.
    const t0 = performance.now();
    const use = await decisionUseEnabled(ownerId, 'passage_scoring');
    const limit = args.passageLimit;
    const found = await searchChunks({
      ...passageArgs,
      q: gc.query,
      limit: use ? passageScoringPool(use, limit) : limit,
    });
    const key = (h: (typeof found)[number]) => `${h.nodeId}:${h.ordinal}`;
    const scoring = use
      ? await scorePassages(
          ownerId,
          gc.query,
          found.map((h) => ({
            id: key(h),
            title: h.nodeTitle,
            heading: h.headingPath,
            text: h.text,
          })),
        )
      : null;
    passageLists['passage-scored'] = toCands(
      scoring?.mode === 'live'
        ? applyPassageScores(found, key, scoring).kept.slice(0, limit)
        : found.slice(0, limit),
    );
    scoredMs = Math.round(performance.now() - t0);
  }
  if (want.has('passage-keyword'))
    passageLists['passage-keyword'] = toCands(
      await searchChunks({ ...passageArgs, q: gc.query, arms: 'keyword' }),
    );

  const ranks: Partial<Record<Retriever, number>> = {};
  const passageRanks: Partial<Record<Retriever, number>> = {};
  const passageDocs: Partial<Record<Retriever, number>> = {};
  for (const r of args.retrievers) {
    const pl = passageLists[r];
    if (pl) {
      passageDocs[r] = new Set(pl.map((c) => c.id)).size;
      ranks[r] = goldRank(dedup(pl), gc);
      if (gc.expectChunks?.length) passageRanks[r] = passageRank(pl, gc);
    } else if (lists[r]) {
      ranks[r] = goldRank(lists[r]!, gc);
    }
  }
  const prod = lists.prod ?? [];
  const search = lists.search ?? [];

  let factHit: boolean | null = null;
  if (ctx && gc.expectFactIncludes?.length) {
    const blob = ctx.facts.map((f) => f.content.toLowerCase()).join('\n');
    factHit = gc.expectFactIncludes.some((s) => blob.includes(s.toLowerCase()));
  }

  // Pollution: for avoid-cases, did junk reach the actual prompt (prod content
  // hits) or the search tool's top window?
  let prodJunk: boolean | null = null;
  let searchJunk: boolean | null = null;
  if (gc.avoidTitleIncludes?.length) {
    // Measure both in the window that actually reaches the model: prod's content
    // hits, and the search tool's top-5 (down-weight ≠ exclude, so junk can still
    // sit deep in a top-20 list — that's fine, it just shouldn't be near the top).
    prodJunk = prod.some((c) => isJunk(c, gc));
    searchJunk = search.slice(0, 5).some((c) => isJunk(c, gc));
  }

  return {
    id: gc.id,
    query: gc.query,
    group: gc.group ?? null,
    ranks,
    passageRanks,
    passageMs,
    scoredMs,
    passageDocs,
    factHit,
    prodJunk,
    searchJunk,
  };
}

type Metrics = { recall: Record<string, number>; mrr: number; n: number };

/** recall@k + MRR over the cases that carry a rank for `retriever` in `pick`
 *  (document ranks, or passage ranks for cases with expectChunks). */
function aggregate(
  results: CaseResult[],
  retriever: Retriever,
  pick: (r: CaseResult) => Partial<Record<Retriever, number>> = (r) => r.ranks,
): Metrics {
  const ranks = results
    .map((r) => pick(r)[retriever])
    .filter((x): x is number => typeof x === 'number');
  const n = ranks.length;
  const recall: Record<string, number> = {};
  for (const k of K_VALUES) {
    const hits = ranks.filter((rank) => rank > 0 && rank <= k).length;
    recall[`@${k}`] = n ? hits / n : 0;
  }
  const mrr = n ? ranks.reduce((s, rank) => s + (rank > 0 ? 1 / rank : 0), 0) / n : 0;
  return { recall, mrr, n };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`.padStart(4);
}

function printTable(label: string, rows: Array<[string, Metrics]>): void {
  console.log(
    `\n  ${label.padEnd(18)} ${K_VALUES.map((k) => `R@${k}`.padStart(6)).join('')}   MRR    n`,
  );
  console.log(`  ${'-'.repeat(18)} ${'-'.repeat(6 * K_VALUES.length)}   ----  ---`);
  for (const [name, m] of rows) {
    const rcells = K_VALUES.map((k) => pct(m.recall[`@${k}`]!).padStart(6)).join('');
    console.log(`  ${name.padEnd(18)} ${rcells}   ${m.mrr.toFixed(2)}  ${String(m.n).padStart(3)}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ownerId = env('ALLOWED_USER_ID');
  if (!ownerId) {
    console.error('eval-recall: ALLOWED_USER_ID must be set');
    process.exit(1);
  }

  // Only `prod` needs a responder agent; the other retrievers run on a bare
  // corpus (a throwaway copy with no agents is fine).
  let agent: Agent | null = null;
  if (args.retrievers.includes('prod')) {
    [agent = null] = await db
      .select()
      .from(agents)
      .where(
        and(eq(agents.ownerId, ownerId), eq(agents.role, 'responder'), eq(agents.enabled, true)),
      )
      .orderBy(desc(agents.priority))
      .limit(1);
    if (!agent) {
      console.error('eval-recall: no enabled responder agent for this owner (or drop `prod`)');
      process.exit(1);
    }
  }

  // The gold set is deliberately NOT in the repo: a case pins node ids from ONE
  // brain, so a shared set is both personal and useless elsewhere. Say how to
  // make one rather than dying on ENOENT.
  let raw: string;
  try {
    raw = readFileSync(args.casesPath, 'utf8');
  } catch {
    console.error(
      `No gold cases at ${args.casesPath}.\n` +
        'The set is local-only and gitignored — it names your own pages by id, so it cannot ship.\n' +
        'Write a JSON array of { id, query, expectNodeIds?|expectNodeTitleIncludes? } there, ' +
        'or point elsewhere with --cases=<path>. See docs/recall-eval.md.',
    );
    process.exit(1);
  }
  let cases: GoldCase[] = JSON.parse(raw);
  if (args.onlyCase) cases = cases.filter((c) => c.id === args.onlyCase);
  if (cases.length === 0) {
    console.error('eval-recall: no cases to run');
    process.exit(1);
  }

  const results: CaseResult[] = [];
  for (const gc of cases) results.push(await runCase(gc, agent, ownerId, args));

  const retrievers = args.retrievers;
  const passageRetrievers = retrievers.filter((r) => PASSAGE_RETRIEVERS.includes(r));
  const metrics = {} as Partial<Record<Retriever, Metrics>>;
  for (const r of retrievers) metrics[r] = aggregate(results, r);
  const passageMetrics = {} as Partial<Record<Retriever, Metrics>>;
  for (const r of passageRetrievers)
    passageMetrics[r] = aggregate(results, r, (c) => c.passageRanks);
  // Per-group passage scores (only when cases carry a group label).
  const groups = [...new Set(results.map((r) => r.group).filter((g): g is string => !!g))].sort();
  const groupMetrics: Record<string, Partial<Record<Retriever, Metrics>>> = {};
  for (const g of groups) {
    const inGroup = results.filter((r) => r.group === g);
    groupMetrics[g] = {};
    for (const r of passageRetrievers)
      groupMetrics[g]![r] = aggregate(inGroup, r, (c) => c.passageRanks);
  }

  const snapshot = {
    at: new Date().toISOString(),
    owner: ownerId,
    agent: agent?.slug ?? null,
    rankK: args.rankK,
    passageLimit: args.passageLimit,
    cases: results,
    metrics,
    passageMetrics,
    groupMetrics,
  };
  mkdirSync(dirname(args.outPath), { recursive: true });
  writeFileSync(args.outPath, JSON.stringify(snapshot, null, 2));

  if (args.json) {
    console.log(JSON.stringify(snapshot, null, 2));
    process.exit(0);
  }

  // ── Per-case ranks ──────────────────────────────────────────────────────
  console.log(
    `\nRecall eval · agent=${agent?.slug ?? '-'} · ${results.length} cases · RANK_K=${args.rankK}\n`,
  );
  console.log(
    `  ${'case'.padEnd(22)} ${retrievers.map((r) => r.slice(0, 9).padStart(10)).join('')}`,
  );
  console.log(`  ${'-'.repeat(22)} ${'-'.repeat(10 * retrievers.length)}`);
  for (const r of results) {
    const cells = retrievers
      .map((ret) => {
        const rank = r.ranks[ret] ?? 0;
        return (rank > 0 ? `#${rank}` : '—').padStart(10);
      })
      .join('');
    console.log(`  ${r.id.slice(0, 22).padEnd(22)} ${cells}`);
  }

  // ── Aggregate ───────────────────────────────────────────────────────────
  printTable(
    'document',
    retrievers.map((r) => [r, metrics[r]!]),
  );
  if (passageRetrievers.some((r) => passageMetrics[r]!.n > 0)) {
    printTable(
      'passage (exact)',
      passageRetrievers.map((r) => [r, passageMetrics[r]!]),
    );
    for (const g of groups)
      printTable(
        `passage · ${g}`,
        passageRetrievers.map((r) => [r, groupMetrics[g]![r]!]),
      );
  }

  const scored = results
    .map((r) => r.scoredMs)
    .filter((x): x is number => x !== null)
    .sort((a, b) => a - b);
  if (scored.length)
    console.log(
      `  passage-scored latency: p50 ${scored[Math.floor(scored.length / 2)]} ms, ` +
        `p90 ${scored[Math.floor(scored.length * 0.9)]} ms (search + decision)`,
    );
  for (const r of passageRetrievers) {
    const docs = results.map((c) => c.passageDocs[r]).filter((x): x is number => x !== undefined);
    if (docs.length)
      console.log(
        `  ${r}: ${(docs.reduce((a, b) => a + b, 0) / docs.length).toFixed(1)} distinct documents per result`,
      );
  }

  const times = results
    .map((r) => r.passageMs)
    .filter((x): x is number => x !== null)
    .sort((a, b) => a - b);
  if (times.length)
    console.log(
      `\n  passage search latency: p50 ${times[Math.floor(times.length / 2)]} ms, ` +
        `p90 ${times[Math.floor(times.length * 0.9)]} ms (hybrid, ${times.length} queries)`,
    );

  // prod reality call-out
  if (agent) {
    const prodHit = results.filter((r) => (r.ranks.prod ?? 0) > 0).length;
    console.log(
      `\n  prod reality: gold node reached the prompt in ${prodHit}/${results.length} cases ` +
        `(content_hit_limit=${(agent.memoryConfig as { content_hit_limit?: number })?.content_hit_limit ?? 5}).`,
    );
  }

  // pollution call-out (avoid-cases only)
  const avoidCases = results.filter((r) => r.prodJunk !== null);
  if (avoidCases.length) {
    const prodPolluted = avoidCases.filter((r) => r.prodJunk).length;
    const searchPolluted = avoidCases.filter((r) => r.searchJunk).length;
    const lam = env('MANTLE_SALIENCE_LAMBDA') ?? '0.15';
    console.log(
      `  pollution (λ=${lam}): bulk/marketing reached the prompt in ${prodPolluted}/${avoidCases.length} avoid-cases (prod), ` +
        `${searchPolluted}/${avoidCases.length} (search). Lower is better.`,
    );
  }

  // ── Baseline delta ──────────────────────────────────────────────────────
  if (args.baselinePath) {
    try {
      const base = JSON.parse(readFileSync(args.baselinePath, 'utf8'));
      console.log(`\n  Δ vs ${args.baselinePath} (taken ${base.at}):`);
      const sign = (x: number) => (x >= 0 ? '+' : '');
      const delta = (name: string, now: Metrics, bm: Metrics | undefined) => {
        if (!bm) return;
        const dR = now.recall['@10']! - (bm.recall['@10'] ?? 0);
        const dR3 = now.recall['@3']! - (bm.recall['@3'] ?? 0);
        const dMrr = now.mrr - (bm.mrr ?? 0);
        console.log(
          `    ${name.padEnd(18)} R@3 ${sign(dR3)}${(dR3 * 100).toFixed(0)}pp   R@10 ${sign(dR)}${(dR * 100).toFixed(0)}pp   MRR ${sign(dMrr)}${dMrr.toFixed(2)}`,
        );
      };
      for (const ret of retrievers) delta(ret, metrics[ret]!, base.metrics?.[ret]);
      for (const ret of passageRetrievers)
        delta(`${ret} (exact)`, passageMetrics[ret]!, base.passageMetrics?.[ret]);
    } catch (err) {
      console.error(`  (could not read baseline: ${err instanceof Error ? err.message : err})`);
    }
  }

  console.log(`\n  snapshot → ${args.outPath}\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
