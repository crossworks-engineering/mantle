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
 * Usage:
 *   ALLOWED_USER_ID=<uuid> pnpm -C apps/web eval:recall
 *   ALLOWED_USER_ID=<uuid> pnpm -C apps/web eval:recall --rank-k=30
 *   ALLOWED_USER_ID=<uuid> pnpm -C apps/web eval:recall --case=sermon-potter-clay
 *   ALLOWED_USER_ID=<uuid> pnpm -C apps/web eval:recall --baseline=scripts/eval/last-run.json
 *   ALLOWED_USER_ID=<uuid> pnpm -C apps/web eval:recall --json    # machine-readable only
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
import { loadConversationContext } from '@mantle/agent-runtime';

const HERE = dirname(fileURLToPath(import.meta.url));
// `fts` = legacy FTS-only searchNodes (the pre-(b) baseline, kept as a reference
// for why we changed it). `search` = the shipped hybrid searchNodes the `search`
// / `search_nodes` tools now use (vector-led + FTS booster).
const RETRIEVERS = ['prod', 'vector', 'fts', 'search', 'chunks', 'rrf'] as const;
type Retriever = (typeof RETRIEVERS)[number];
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
  note?: string;
};

/** One retrieved candidate, normalised across every retriever. */
type Candidate = { id: string; title: string };

type Args = {
  rankK: number;
  casesPath: string;
  outPath: string;
  baselinePath: string | null;
  onlyCase: string | null;
  json: boolean;
};

function parseArgs(argv: string[]): Args {
  const out: Args = {
    rankK: 20,
    casesPath: resolve(HERE, 'eval/recall-cases.json'),
    outPath: resolve(HERE, 'eval/last-run.json'),
    baselinePath: null,
    onlyCase: null,
    json: false,
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
  ranks: Record<Retriever, number>;
  /** prod-only: did an expected fact substring appear in the facts Saskia saw? */
  factHit: boolean | null;
  /** For avoid-cases: did bulk/marketing junk reach the prompt window? null when
   *  the case has no avoid list. Measured on prod (the actual prompt) + search. */
  prodJunk: boolean | null;
  searchJunk: boolean | null;
};

async function runCase(
  gc: GoldCase,
  agent: Agent,
  ownerId: string,
  rankK: number,
): Promise<CaseResult> {
  const queryVec = await embed(ownerId, gc.query.slice(0, 2000));

  // prod: exactly what Saskia assembles (content hits capped + cutoff applied).
  const ctx = await loadConversationContext({ ownerId, agent, inboundText: gc.query });
  const prod: Candidate[] = ctx.contentHits.map((h) => ({ id: h.nodeId, title: h.title }));

  // vector / fts / search / chunks at RANK_K.
  const vector = await vectorNodes(ownerId, queryVec, rankK);
  const ftsRows = await searchNodes({ ownerId, q: gc.query, limit: rankK }); // legacy FTS-only
  const fts: Candidate[] = ftsRows.map((r) => ({ id: r.id, title: r.title }));
  const searchRows = await searchNodes({
    ownerId,
    q: gc.query,
    limit: rankK,
    queryEmbedding: queryVec, // the shipped hybrid path
  });
  const search: Candidate[] = searchRows.map((r) => ({ id: r.id, title: r.title }));
  const chunkRows = await searchChunks({ ownerId, embedding: queryVec, limit: rankK });
  const chunks = dedup(chunkRows.map((r) => ({ id: r.nodeId, title: r.nodeTitle })));

  const rrf = fuseRRF([vector, fts, chunks]);

  const lists: Record<Retriever, Candidate[]> = { prod, vector, fts, search, chunks, rrf };
  const ranks = {} as Record<Retriever, number>;
  for (const r of RETRIEVERS) ranks[r] = goldRank(lists[r], gc);

  let factHit: boolean | null = null;
  if (gc.expectFactIncludes?.length) {
    const blob = ctx.facts.map((f) => f.content.toLowerCase()).join('\n');
    factHit = gc.expectFactIncludes.some((s) => blob.includes(s.toLowerCase()));
  }

  // Pollution: for avoid-cases, did junk reach the actual prompt (prod content
  // hits) or the search tool's top window?
  let prodJunk: boolean | null = null;
  let searchJunk: boolean | null = null;
  if (gc.avoidTitleIncludes?.length) {
    prodJunk = prod.some((c) => isJunk(c, gc));
    searchJunk = search.slice(0, rankK).some((c) => isJunk(c, gc));
  }

  return { id: gc.id, query: gc.query, ranks, factHit, prodJunk, searchJunk };
}

type Metrics = { recall: Record<string, number>; mrr: number; n: number };

function aggregate(results: CaseResult[], retriever: Retriever): Metrics {
  const n = results.length;
  const recall: Record<string, number> = {};
  for (const k of K_VALUES) {
    const hits = results.filter((r) => {
      const rank = r.ranks[retriever];
      return rank > 0 && rank <= k;
    }).length;
    recall[`@${k}`] = n ? hits / n : 0;
  }
  const mrr = n
    ? results.reduce((s, r) => s + (r.ranks[retriever] > 0 ? 1 / r.ranks[retriever] : 0), 0) / n
    : 0;
  return { recall, mrr, n };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`.padStart(4);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ownerId = process.env.ALLOWED_USER_ID;
  if (!ownerId) {
    console.error('eval-recall: ALLOWED_USER_ID must be set');
    process.exit(1);
  }

  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.ownerId, ownerId), eq(agents.role, 'responder'), eq(agents.enabled, true)))
    .orderBy(desc(agents.priority))
    .limit(1);
  if (!agent) {
    console.error('eval-recall: no enabled responder agent for this owner');
    process.exit(1);
  }

  let cases: GoldCase[] = JSON.parse(readFileSync(args.casesPath, 'utf8'));
  if (args.onlyCase) cases = cases.filter((c) => c.id === args.onlyCase);
  if (cases.length === 0) {
    console.error('eval-recall: no cases to run');
    process.exit(1);
  }

  const results: CaseResult[] = [];
  for (const gc of cases) results.push(await runCase(gc, agent, ownerId, args.rankK));

  const metrics = {} as Record<Retriever, Metrics>;
  for (const r of RETRIEVERS) metrics[r] = aggregate(results, r);

  const snapshot = {
    at: new Date().toISOString(),
    owner: ownerId,
    agent: agent.slug,
    rankK: args.rankK,
    cases: results,
    metrics,
  };
  mkdirSync(dirname(args.outPath), { recursive: true });
  writeFileSync(args.outPath, JSON.stringify(snapshot, null, 2));

  if (args.json) {
    console.log(JSON.stringify(snapshot, null, 2));
    process.exit(0);
  }

  // ── Per-case ranks ──────────────────────────────────────────────────────
  console.log(
    `\nRecall eval · agent=${agent.slug} · ${results.length} cases · RANK_K=${args.rankK}\n`,
  );
  console.log(`  ${'case'.padEnd(22)} ${RETRIEVERS.map((r) => r.padStart(7)).join('')}`);
  console.log(`  ${'-'.repeat(22)} ${'-'.repeat(7 * RETRIEVERS.length)}`);
  for (const r of results) {
    const cells = RETRIEVERS.map((ret) => {
      const rank = r.ranks[ret];
      return (rank > 0 ? `#${rank}` : '—').padStart(7);
    }).join('');
    console.log(`  ${r.id.padEnd(22)} ${cells}`);
  }

  // ── Aggregate ───────────────────────────────────────────────────────────
  console.log(`\n  ${'retriever'.padEnd(10)} ${K_VALUES.map((k) => `R@${k}`.padStart(6)).join('')}   MRR`);
  console.log(`  ${'-'.repeat(10)} ${'-'.repeat(6 * K_VALUES.length)}   ----`);
  for (const ret of RETRIEVERS) {
    const m = metrics[ret];
    const rcells = K_VALUES.map((k) => pct(m.recall[`@${k}`]!).padStart(6)).join('');
    console.log(`  ${ret.padEnd(10)} ${rcells}   ${m.mrr.toFixed(2)}`);
  }

  // prod reality call-out
  const prodHit = results.filter((r) => r.ranks.prod > 0).length;
  console.log(
    `\n  prod reality: gold node reached the prompt in ${prodHit}/${results.length} cases ` +
      `(content_hit_limit=${(agent.memoryConfig as { content_hit_limit?: number })?.content_hit_limit ?? 5}).`,
  );

  // pollution call-out (avoid-cases only)
  const avoidCases = results.filter((r) => r.prodJunk !== null);
  if (avoidCases.length) {
    const prodPolluted = avoidCases.filter((r) => r.prodJunk).length;
    const searchPolluted = avoidCases.filter((r) => r.searchJunk).length;
    const lam = process.env.MANTLE_SALIENCE_LAMBDA ?? '0.15';
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
      for (const ret of RETRIEVERS) {
        const bm: Metrics | undefined = base.metrics?.[ret];
        if (!bm) continue;
        const dR3 = metrics[ret].recall['@3']! - (bm.recall['@3'] ?? 0);
        const dMrr = metrics[ret].mrr - (bm.mrr ?? 0);
        const sign = (x: number) => (x >= 0 ? '+' : '');
        console.log(
          `    ${ret.padEnd(10)} R@3 ${sign(dR3)}${(dR3 * 100).toFixed(0)}pp   MRR ${sign(dMrr)}${dMrr.toFixed(2)}`,
        );
      }
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
