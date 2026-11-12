/**
 * The subject box's `workerModel` case (phase 4, docs/control-center.md
 * "Fleet writes"): the model of the AI worker that runs a shipped kind (the
 * kind's default worker), as the AI workers screen sets it. A case on the
 * signed route like the others (box.ts, fleet-writes.ts), so the same two
 * checks hold it and no agent, MCP client or API key on the box reaches it.
 *
 * Its own checks, no more:
 *  1. the kind is one the system ships (the manifest's workers), not
 *     `embedding` (a new model there would not match the stored vectors),
 *     and this box has a default worker of it;
 *  2. that worker's provider is the one the change names: a model id means
 *     something on one provider only, so a model from a box on another
 *     provider is never set here;
 *  3. the box's model policy allows the model on that worker's route (its
 *     own provider and base URL), and, on OpenRouter, the model is in the
 *     catalog and does the kind's job (the screen's own save-time check;
 *     a catalog that does not load within CATALOG_WAIT_MS lets it through,
 *     as the screen does when it cannot reach it).
 * Then the screen's own update (updateAiWorker), the model field only: the
 * provider, its key, its base URL and its backup route stay. The box's
 * audit row is written by the route (box.ts).
 */
import { aiWorkers, and, db, eq } from '@mantle/db';
import { openRouterModelIssue, updateAiWorker } from '@/lib/ai-workers';
import { modelPolicyIssue } from '@/lib/model-policy-save';
import { MANIFEST_WORKERS } from '@/lib/system-manifest/manifest';

/** What a workerModel call answers: ok and the model it had, or one fixed
 *  reason. Never a check's text. */
export type WorkerModelAnswer = {
  kind: 'workerModel';
  ok: boolean;
  /** The model before the call (ok), or now (refused by a check). */
  was?: string;
  reason?: 'worker' | 'provider' | 'policy' | 'model';
};

/** The kinds a fleet write may set: the shipped ones, never embedding. */
export const FLEET_WORKER_KINDS: ReadonlySet<string> = new Set(
  MANIFEST_WORKERS.map((w) => String(w.kind)).filter((k) => k !== 'embedding'),
);

/** The catalog check's wait: well inside the CC's call timeout, so a cold
 *  catalog never makes the box read as unreachable. */
export const CATALOG_WAIT_MS = 3000;

export async function setWorkerModel(
  ownerId: string,
  kind: string,
  provider: string,
  model: string,
): Promise<WorkerModelAnswer> {
  const answer = (a: Omit<WorkerModelAnswer, 'kind'>): WorkerModelAnswer => ({
    kind: 'workerModel',
    ...a,
  });
  if (!FLEET_WORKER_KINDS.has(kind)) return answer({ ok: false, reason: 'worker' });
  const [row] = await db
    .select({
      id: aiWorkers.id,
      kind: aiWorkers.kind,
      provider: aiWorkers.provider,
      model: aiWorkers.model,
      baseUrl: aiWorkers.baseUrl,
    })
    .from(aiWorkers)
    .where(
      and(
        eq(aiWorkers.ownerId, ownerId),
        // The enum column, matched by its text: `kind` is a shipped kind.
        eq(aiWorkers.kind, kind as (typeof aiWorkers.kind.enumValues)[number]),
        eq(aiWorkers.isDefault, true),
      ),
    )
    .limit(1);
  if (!row) return answer({ ok: false, reason: 'worker' });
  const was = row.model ?? '';
  if (row.provider !== provider) return answer({ ok: false, was, reason: 'provider' });
  if (modelPolicyIssue(row.provider, model, row.baseUrl)) {
    return answer({ ok: false, was, reason: 'policy' });
  }
  if (row.model === model) return answer({ ok: true, was });
  if (await catalogIssue(String(row.kind), row.provider, model)) {
    return answer({ ok: false, was, reason: 'model' });
  }
  const done = await updateAiWorker(ownerId, row.id, { model });
  return done ? answer({ ok: true, was }) : answer({ ok: false, reason: 'worker' });
}

/** The screen's catalog check, waited on for CATALOG_WAIT_MS at most. */
async function catalogIssue(kind: string, provider: string, model: string): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), CATALOG_WAIT_MS);
  });
  try {
    const issue = await Promise.race([
      openRouterModelIssue({ kind, provider, model }).catch(() => null),
      late,
    ]);
    return issue !== null;
  } finally {
    clearTimeout(timer);
  }
}
