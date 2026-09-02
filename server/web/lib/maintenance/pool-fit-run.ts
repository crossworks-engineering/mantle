/**
 * Pool-fit — the DB + network half.
 *
 * Gathers two sets of subjects and asks one question of each: does this model
 * do the job the pool (or the worker kind) needs?
 *
 *   1. Every `curated_models` row — the shortlists at /models/pools.
 *   2. Every enabled `agents` and `ai_workers` row on an OpenRouter route — the
 *      models that actually spend money. These predate the save-time guard, so
 *      a misfit here is the one that is billing today.
 *
 * Lives in `lib/` rather than the script so the nightly cron runs the SAME
 * definition (the cron dispatches in-process and never spawns scripts — a
 * report that exists only inside a script gets marked schedulable and never
 * runs once, which is exactly what happened to `deps-drift`).
 *
 * Read-only and free: two selects, one keyless catalog fetch (6h-cached by
 * @mantle/tracing), no model invoked, nothing written.
 */
import { db, agents, aiWorkers, curatedModels, eq, type CuratedRoute } from '@mantle/db';
import { refreshModelCatalog, catalogModalities } from '@mantle/tracing';
import { MODEL_POOL_IDS } from '@mantle/client-types/model-pools';
import { classifyFits, type FitSubject, type PoolFitResult } from './pool-fit';

/** A worker template whose model resolves at run time from whichever responder
 *  runs it (migration 0131) — there is no id to check. */
const INHERIT = 'inherit';

/**
 * Only OpenRouter slugs are checkable here: the modality facts come from
 * OpenRouter's catalog, and a direct-provider slug (`claude-opus-5`) is not in
 * it. Reporting those as misfits would be inventing evidence — they are simply
 * out of scope and are not collected.
 */
const OPENROUTER = 'openrouter';

/** Every model this brain has recorded that we can check, with its context. */
export async function collectFitSubjects(): Promise<FitSubject[]> {
  const [poolRows, workerRows, agentRows] = await Promise.all([
    db
      .select({ pool: curatedModels.pool, name: curatedModels.name, routes: curatedModels.routes })
      .from(curatedModels),
    db
      .select({
        name: aiWorkers.name,
        kind: aiWorkers.kind,
        provider: aiWorkers.provider,
        model: aiWorkers.model,
      })
      .from(aiWorkers)
      .where(eq(aiWorkers.enabled, true)),
    db
      .select({ slug: agents.slug, provider: agents.provider, model: agents.model })
      .from(agents)
      .where(eq(agents.enabled, true)),
  ]);

  const subjects: FitSubject[] = [];
  for (const row of poolRows) {
    const routes = row.routes as CuratedRoute[];
    const route = routes.find((r) => r.provider === OPENROUTER);
    if (!route) continue;
    subjects.push({ source: 'pool', pool: row.pool, label: row.name, model: route.model });
  }
  for (const w of workerRows) {
    if (w.provider !== OPENROUTER || !w.model || w.model === INHERIT) continue;
    // Worker kinds and pool ids share one vocabulary, minus `embedding`
    // (locked to the 768-dim local singleton, so it has no pool and no
    // contract to check).
    if (!MODEL_POOL_IDS.has(w.kind)) continue;
    subjects.push({ source: 'worker', pool: w.kind, label: w.name, model: w.model });
  }
  for (const a of agentRows) {
    if (a.provider !== OPENROUTER || !a.model || a.model === INHERIT) continue;
    // Every conversational agent draws from the one shared `agents` pool.
    subjects.push({ source: 'agent', pool: 'agents', label: a.slug, model: a.model });
  }
  return subjects;
}

export async function runPoolFit(): Promise<PoolFitResult> {
  const subjects = await collectFitSubjects();
  // One keyless fetch for the whole report; every lookup below is a map hit.
  await refreshModelCatalog();
  return classifyFits(subjects, (model) => catalogModalities(model));
}
