/**
 * The subject box's `workerModel` case (phase 4, docs/control-center.md
 * "Fleet writes"): the model of the AI worker that runs a shipped kind, as
 * the AI workers screen sets it. A case on the signed route like the
 * others (box.ts, fleet-writes.ts), so the same two checks hold it and no
 * agent, MCP client or API key on the box reaches it.
 *
 * The worker is the one the runtime runs for the kind: getDefaultWorker,
 * the runtime's own rule (the enabled default, else the top-priority
 * enabled worker), so the change lands on what the box really runs. Its
 * checks, no more:
 *  1. the kind is one the system ships (the manifest's workers), not
 *     `embedding` (a new model there would not match the stored vectors),
 *     and the box runs a worker of it (`worker`);
 *  2. that worker runs on the change's provider and endpoint (endpoint.ts,
 *     a print of its base URL): a model id means something on one route
 *     only (`route`);
 *  3. the box's model policy allows the model on that worker's route (its
 *     own provider and base URL), and, on OpenRouter, the model is in the
 *     catalog and does the kind's job (the screen's own save-time check;
 *     a catalog that does not load within CATALOG_WAIT_MS lets it through,
 *     as the screen does when it cannot reach it).
 * Then the screen's own update (updateAiWorker), the model field only: the
 * provider, its key, its base URL and its backup route stay. It answers
 * with the id of the worker it set. The box's audit row is written by the
 * route (box.ts).
 */
import { getDefaultWorker, type AiWorkerKind } from '@mantle/db';
import { openRouterModelIssue, updateAiWorker } from '@/lib/ai-workers';
import { modelPolicyIssue } from '@/lib/model-policy-save';
import { MANIFEST_WORKERS } from '@/lib/system-manifest/manifest';
import { endpointPrint } from './endpoint';

/** What a workerModel call answers: ok, the model it had and the worker it
 *  set, or one fixed reason. Never a check's text. */
export type WorkerModelAnswer = {
  kind: 'workerModel';
  ok: boolean;
  /** The model before the call (ok), or now (refused by a check). */
  was?: string;
  /** The worker the box runs for the kind (set, or checked). */
  workerId?: string;
  reason?: 'worker' | 'route' | 'policy' | 'model';
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
  model: string,
  route: { provider: string; endpoint: string },
): Promise<WorkerModelAnswer> {
  const answer = (a: Omit<WorkerModelAnswer, 'kind'>): WorkerModelAnswer => ({
    kind: 'workerModel',
    ...a,
  });
  if (!FLEET_WORKER_KINDS.has(kind)) return answer({ ok: false, reason: 'worker' });
  // `kind` is a shipped kind (checked above), so a value of the enum.
  const row = await getDefaultWorker(ownerId, kind as AiWorkerKind);
  if (!row) return answer({ ok: false, reason: 'worker' });
  const was = row.model ?? '';
  const workerId = row.id;
  if (row.provider !== route.provider || endpointPrint(row.baseUrl) !== route.endpoint) {
    return answer({ ok: false, was, workerId, reason: 'route' });
  }
  if (modelPolicyIssue(row.provider, model, row.baseUrl)) {
    return answer({ ok: false, was, workerId, reason: 'policy' });
  }
  if (row.model === model) return answer({ ok: true, was, workerId });
  if (await catalogIssue(String(row.kind), row.provider, model)) {
    return answer({ ok: false, was, workerId, reason: 'model' });
  }
  const done = await updateAiWorker(ownerId, row.id, { model });
  return done ? answer({ ok: true, was, workerId }) : answer({ ok: false, reason: 'worker' });
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
