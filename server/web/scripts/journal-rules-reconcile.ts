/**
 * Clean up an agent's learned Journal rules: copies and stale versions
 * (spike 14, dev-brain page d58e4ed3). Maintenance task
 * `journal-rules-reconcile`.
 *
 *   dry run (default): every pair of the agent's live learned rules at or
 *     above the similarity floor goes to the decider's `rule_reconcile` use
 *     ("same rule?", "does the newer one change the older?"); the plan of
 *     OLDER rules to retire, each into its newer rule, is written to a review
 *     page. Needs the use enabled (shadow or live: the review page is the
 *     gate here, not the mode).
 *   --apply --page=<id>: that exact plan is applied as supersede marks
 *     (reversible). A retire whose rules changed since the dry run is skipped.
 */
import { and, eq } from 'drizzle-orm';
import { closeDb, db, nodes } from '@mantle/db';
import {
  RECONCILE_PLAN_DATA_KEY,
  applyReconcilePlan,
  createPage,
  loadLearnedRules,
  markdownToDoc,
  pairExistingRules,
  parseReconcilePlan,
  planRetires,
  renderReconcilePlanMarkdown,
  type ReconcilePlan,
  type RulePairScore,
} from '@mantle/content';
import { ruleReconcilerFor } from '@mantle/tools';
import { env } from '@mantle/config';

const OWNER_ID = env('ALLOWED_USER_ID');
// Pairs per judge call: 5 decider requests of 20 pairs run at once, the rest
// wait, so a brain with hundreds of pairs does not open 40 requests at once.
const JUDGE_CHUNK = 100;

const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

async function dryRun(ownerId: string, slug: string) {
  const rules = await loadLearnedRules(ownerId, slug);
  if (rules.length < 2) {
    console.log(`agent '${slug}' has ${rules.length} live learned rule(s); nothing to compare`);
    return;
  }
  const reconciler = ruleReconcilerFor(ownerId);
  const vecs = await reconciler.embed(rules.map((r) => r.body));
  const pairs = pairExistingRules(vecs, reconciler.similarityFloor);
  console.log(`${rules.length} live learned rules; ${pairs.length} close pairs`);

  const judged: Array<{ olderIdx: number; newerIdx: number; score: RulePairScore | null }> = [];
  let threshold: number | null = null;
  let failedCalls = 0;
  for (let i = 0; i < pairs.length; i += JUDGE_CHUNK) {
    const chunk = pairs.slice(i, i + JUDGE_CHUNK);
    const j = await reconciler.judge(
      chunk.map((p) => ({ older: rules[p.a]!.body, newer: rules[p.b]!.body })),
    );
    if (!j) {
      if (threshold === null && i === 0) {
        throw new Error(
          "the decider's rule_reconcile use is off (or its first call failed): enable it in the decider worker's params.uses, shadow or live",
        );
      }
      failedCalls += Math.ceil(chunk.length / 20);
      process.stdout.write('x');
      continue;
    }
    threshold = j.threshold;
    failedCalls += j.failed;
    chunk.forEach((p, k) =>
      judged.push({ olderIdx: p.a, newerIdx: p.b, score: j.scores[k] ?? null }),
    );
    process.stdout.write('.');
  }
  console.log('');
  if (threshold === null) throw new Error('no decider answer; nothing planned');

  const plan: ReconcilePlan = {
    version: 1,
    agentSlug: slug,
    createdAt: new Date().toISOString(),
    threshold,
    rules: rules.length,
    pairs: pairs.length,
    failedCalls,
    retires: planRetires(rules, judged, threshold),
  };
  const page = await createPage(ownerId, {
    title: `Journal rules cleanup (dry run): ${slug}`,
    icon: '🧹',
    tags: ['journal', 'rule-reconcile', 'dry-run'],
    doc: markdownToDoc(
      renderReconcilePlanMarkdown(
        plan,
        'pnpm maintain journal-rules-reconcile --apply --page=<this page id> --yes',
      ),
    ),
    data: { [RECONCILE_PLAN_DATA_KEY]: plan },
  });
  console.log(`${plan.retires.length} rule(s) to retire; review page: ${page.id}`);
  console.log(`apply with:  pnpm maintain journal-rules-reconcile --apply --page=${page.id} --yes`);
}

async function apply(ownerId: string, pageId: string) {
  const [row] = await db
    .select({ data: nodes.data })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), eq(nodes.id, pageId), eq(nodes.type, 'page')))
    .limit(1);
  if (!row) throw new Error(`no page ${pageId} for this owner`);
  const plan = parseReconcilePlan(
    (row.data as Record<string, unknown> | null)?.[RECONCILE_PLAN_DATA_KEY],
  );
  const r = await applyReconcilePlan(ownerId, plan);
  console.log(
    `agent '${plan.agentSlug}': retired ${r.applied} rule(s), skipped ${r.skipped} (changed since the dry run), ${r.errors} failed`,
  );
}

async function main() {
  if (!OWNER_ID) throw new Error('ALLOWED_USER_ID must be set');
  if (process.argv.includes('--apply')) {
    const page = arg('page');
    if (!page) throw new Error('--apply needs --page=<review page id>');
    await apply(OWNER_ID, page);
  } else {
    const slug = arg('agent');
    if (!slug) throw new Error('--agent=<slug> is required');
    await dryRun(OWNER_ID, slug);
  }
}

// One-shot script: close the pooled client so the process can exit, and
// set the exit code rather than calling process.exit (flushes output).
main()
  .catch((err) => {
    console.error('journal-rules-reconcile:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
