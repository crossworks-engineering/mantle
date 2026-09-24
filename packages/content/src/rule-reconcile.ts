/**
 * Rule reconcile: keep an agent's learned Journal rules from piling up as
 * copies and stale versions (spike 14, dev-brain page d58e4ed3).
 *
 * The decider's `rule_reconcile` use judges (older, newer) pairs of the
 * agent's own learned rules: "same rule" and "newer changes the older". When
 * either clears the threshold, the OLDER rule is superseded by the newer one.
 * Dates pick the newer rule, never the model. Two places use it:
 *
 *   on write (writeLearnedEntries): each rule the reflector or update_persona
 *     writes is paired with the agent's close existing rules;
 *   cleanup (maintenance task `journal-rules-reconcile`): every close pair of
 *     existing rules, as a dry run → review page → apply, like the persona
 *     notes conversion.
 *
 * Only rules THIS agent learned are ever candidates (journalLearnedSql +
 * agent_slug): what an agent records for the user is the user's knowledge and
 * is never retired here. A supersede mark is reversible (unsupersedeNode).
 *
 * This package does not depend on the decider or the embedder; the caller
 * passes a {@link RuleReconciler} (built in @mantle/tools).
 */
import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { db, nodes } from '@mantle/db';
import { journalKindSql } from './journal';
import { journalLearnedSql } from './identity-context';
import { supersedeNode } from './supersede';

/** Kinds a learned rule can have (gaps, context and logs are not rules). */
const RULE_KINDS = ['identity', 'goal', 'preference', 'lesson', 'expectation'] as const;

/** Close existing rules a new rule is compared with. */
export const MAX_RULE_CANDIDATES = 5;

/** Key of the cleanup plan inside the review page's `nodes.data`. */
export const RECONCILE_PLAN_DATA_KEY = 'rule_reconcile_plan';

export type RulePairScore = { same: number; replaces: number };

/** What the caller wires in: the embedder and the decider (structural, so
 *  this package needs neither). `judge` returns null when the use is off or
 *  every call failed. */
export type RuleReconciler = {
  embed(texts: string[]): Promise<number[][]>;
  judge(pairs: ReadonlyArray<{ older: string; newer: string }>): Promise<{
    scores: Array<RulePairScore | null>;
    mode: 'shadow' | 'live';
    threshold: number;
    calls: number;
    failed: number;
    ms: number;
  } | null>;
  /** Only pairs at or above this cosine similarity are judged. */
  similarityFloor: number;
};

export type LearnedRule = { id: string; kind: string; body: string; createdAt: Date };

/** One retire: `olderId` is superseded by `newerId`. */
export type RuleRetire = {
  olderId: string;
  newerId: string;
  older: string;
  newer: string;
  same: number;
  replaces: number;
};

export type RuleReconcileReport = {
  mode: 'shadow' | 'live';
  threshold: number;
  pairs: number;
  calls: number;
  failed: number;
  ms: number;
  /** Live: superseded. Shadow: would have been. */
  retires: RuleRetire[];
  /** Live retires that failed to write (e.g. the rule changed meanwhile). */
  errors: number;
};

/** SQL: a live Journal row that is a rule THIS agent learned. The only
 *  rows rule reconcile may ever retire (tested on Postgres in
 *  journal-scope.db.test.ts). */
export function learnedRuleOfAgentSql(agentSlug: string): SQL {
  return and(
    isNull(nodes.supersededBy),
    sql`${journalKindSql()} in (${sql.join(
      RULE_KINDS.map((k) => sql`${k}`),
      sql`, `,
    )})`,
    journalLearnedSql(),
    sql`coalesce(btrim(${nodes.data}->>'agent_slug'), '') = ${agentSlug}`,
  )!;
}

/** The live rules this agent learned, oldest first (id breaks a tie). */
export async function loadLearnedRules(ownerId: string, agentSlug: string): Promise<LearnedRule[]> {
  const rows = await db
    .select({
      id: nodes.id,
      data: nodes.data,
      createdAt: nodes.createdAt,
      kind: sql<string>`${journalKindSql()}`,
    })
    .from(nodes)
    .where(
      and(eq(nodes.ownerId, ownerId), eq(nodes.type, 'journal'), learnedRuleOfAgentSql(agentSlug)),
    )
    .orderBy(asc(nodes.createdAt), asc(nodes.id));
  return rows
    .map((r) => {
      const d = (r.data ?? {}) as Record<string, unknown>;
      return {
        id: r.id,
        kind: r.kind,
        body: typeof d.body === 'string' ? d.body.trim() : '',
        createdAt: r.createdAt,
      };
    })
    .filter((r) => r.body.length > 0);
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let d = 0;
  let x = 0;
  let y = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i]! * b[i]!;
    x += a[i]! ** 2;
    y += b[i]! ** 2;
  }
  return x === 0 || y === 0 ? 0 : d / Math.sqrt(x * y);
}

/**
 * Pure: pair each new rule with its closest existing rules (at or above
 * `floor`, at most `perRule`, closest first). The existing rule is always the
 * older one of the pair.
 */
export function pairNewWithExisting(
  newVecs: ReadonlyArray<readonly number[]>,
  ruleVecs: ReadonlyArray<readonly number[]>,
  floor: number,
  perRule = MAX_RULE_CANDIDATES,
): Array<{ newIdx: number; ruleIdx: number; sim: number }> {
  const out: Array<{ newIdx: number; ruleIdx: number; sim: number }> = [];
  newVecs.forEach((nv, newIdx) => {
    const close = ruleVecs
      .map((rv, ruleIdx) => ({ newIdx, ruleIdx, sim: cosine(nv, rv) }))
      .filter((p) => p.sim >= floor)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, perRule);
    out.push(...close);
  });
  return out;
}

/**
 * Pure: every pair of existing rules at or above `floor`. `rules` must be
 * oldest first, so `a` (lower index) is always the older rule.
 */
export function pairExistingRules(
  vecs: ReadonlyArray<readonly number[]>,
  floor: number,
): Array<{ a: number; b: number; sim: number }> {
  const out: Array<{ a: number; b: number; sim: number }> = [];
  for (let a = 0; a < vecs.length; a++) {
    for (let b = a + 1; b < vecs.length; b++) {
      const sim = cosine(vecs[a]!, vecs[b]!);
      if (sim >= floor) out.push({ a, b, sim });
    }
  }
  return out;
}

/** Pure: does this pair retire the older rule? Same gate as the decider's
 *  `retiresOlder` (kept here so this package needs no decider). */
export function pairRetires(score: RulePairScore | null, threshold: number): boolean {
  return !!score && (score.same >= threshold || score.replaces >= threshold);
}

/**
 * Pure: the retires of a judged set of (older, newer) pairs. An older rule
 * retired by several newer ones goes to its NEWEST replacement, and every
 * replacement is followed to the living end of the plan's own chain (a rule
 * that is itself retired points on to what retires it). The chain always runs
 * old → new, so it cannot loop.
 */
export function planRetires(
  rules: ReadonlyArray<{ id: string; body: string; createdAt: Date }>,
  judged: ReadonlyArray<{ olderIdx: number; newerIdx: number; score: RulePairScore | null }>,
  threshold: number,
): RuleRetire[] {
  const order = (i: number) => rules[i]!.createdAt.getTime();
  const best = new Map<number, { newerIdx: number; score: RulePairScore }>();
  for (const j of judged) {
    if (!pairRetires(j.score, threshold)) continue;
    const cur = best.get(j.olderIdx);
    if (
      !cur ||
      order(j.newerIdx) > order(cur.newerIdx) ||
      (order(j.newerIdx) === order(cur.newerIdx) && j.newerIdx > cur.newerIdx)
    ) {
      best.set(j.olderIdx, { newerIdx: j.newerIdx, score: j.score! });
    }
  }
  const livingEnd = (i: number): number => {
    let cur = i;
    for (let hops = 0; hops <= rules.length; hops++) {
      const next = best.get(cur);
      if (!next) return cur;
      cur = next.newerIdx;
    }
    return cur;
  };
  return [...best.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([olderIdx, { newerIdx, score }]) => {
      const end = livingEnd(newerIdx);
      return {
        olderId: rules[olderIdx]!.id,
        newerId: rules[end]!.id,
        older: rules[olderIdx]!.body,
        newer: rules[end]!.body,
        same: round2(score.same),
        replaces: round2(score.replaces),
      };
    });
}

/** Supersede each retire's older rule. `version` for a same-rule copy,
 *  `corrected` when the newer rule changes it. Returns how many failed. */
export async function applyRetires(
  ownerId: string,
  retires: readonly RuleRetire[],
  threshold: number,
): Promise<number> {
  let errors = 0;
  for (const r of retires) {
    try {
      await supersedeNode({
        ownerId,
        id: r.olderId,
        supersededBy: r.newerId,
        reason: r.replaces >= threshold ? 'corrected' : 'version',
      });
    } catch (err) {
      errors++;
      console.warn(
        `[rule-reconcile] could not supersede ${r.olderId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return errors;
}

// ─── Cleanup plan (review page) ────────────────────────────────────────────

export type ReconcilePlan = {
  version: 1;
  agentSlug: string;
  createdAt: string;
  threshold: number;
  rules: number;
  pairs: number;
  failedCalls: number;
  retires: RuleRetire[];
};

export function parseReconcilePlan(raw: unknown): ReconcilePlan {
  const fail = (why: string): never => {
    throw new Error(`the review page's plan is not usable: ${why}`);
  };
  if (!raw || typeof raw !== 'object') fail('missing');
  const p = raw as Record<string, unknown>;
  if (p.version !== 1) fail(`version ${String(p.version)} (expected 1)`);
  if (typeof p.agentSlug !== 'string' || !p.agentSlug) fail('no agentSlug');
  if (typeof p.threshold !== 'number') fail('no threshold');
  if (!Array.isArray(p.retires)) fail('no retires');
  (p.retires as unknown[]).forEach((r, i) => {
    const x = (r ?? {}) as Record<string, unknown>;
    if (typeof x.olderId !== 'string' || typeof x.newerId !== 'string')
      fail(`retire ${i} has no ids`);
    if (x.olderId === x.newerId) fail(`retire ${i} retires a rule into itself`);
  });
  return p as unknown as ReconcilePlan;
}

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

export function renderReconcilePlanMarkdown(plan: ReconcilePlan, applyHint: string): string {
  const corrected = plan.retires.filter((r) => r.replaces >= plan.threshold).length;
  return [
    `Dry run: nothing has changed. The decider compared the ${plan.rules} live rules agent ${plan.agentSlug} learned, in ${plan.pairs} close pairs. Below are the OLDER rules it would retire, each superseded by the newer rule beside it (a supersede mark: hidden from turns, kept for audit, reversible). To apply exactly this plan: ${applyHint}.`,
    '',
    '## Summary',
    '',
    '| | Count |',
    '|---|---|',
    `| Live learned rules | ${plan.rules} |`,
    `| Close pairs judged | ${plan.pairs} |`,
    `| Rules to retire | ${plan.retires.length} |`,
    `| of which the newer rule changes it (corrected) | ${corrected} |`,
    `| Failed decider calls (pairs kept) | ${plan.failedCalls} |`,
    '',
    `Gate: same rule or changed, at or above ${plan.threshold}.`,
    '',
    '## Rules to retire',
    '',
    ...(plan.retires.length === 0
      ? ['None.']
      : [
          '| Older rule (retired) | Newer rule (kept) | same | changes |',
          '|---|---|---|---|',
          ...plan.retires.map(
            (r) => `| ${esc(r.older)} | ${esc(r.newer)} | ${r.same} | ${r.replaces} |`,
          ),
        ]),
  ].join('\n');
}

/**
 * Apply a reviewed cleanup plan. A retire is skipped when either rule is no
 * longer live (retired or deleted since the dry run): what changed since the
 * review is not guessed at; re-run the dry run to include it.
 */
export async function applyReconcilePlan(
  ownerId: string,
  plan: ReconcilePlan,
): Promise<{ applied: number; skipped: number; errors: number }> {
  const ids = [...new Set(plan.retires.flatMap((r) => [r.olderId, r.newerId]))];
  const rows =
    ids.length === 0
      ? []
      : await db
          .select({ id: nodes.id })
          .from(nodes)
          .where(
            and(eq(nodes.ownerId, ownerId), isNull(nodes.supersededBy), inArray(nodes.id, ids)),
          );
  const live = new Set(rows.map((r) => r.id));
  const todo = plan.retires.filter((r) => live.has(r.olderId) && live.has(r.newerId));
  const errors = await applyRetires(ownerId, todo, plan.threshold);
  return { applied: todo.length - errors, skipped: plan.retires.length - todo.length, errors };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
