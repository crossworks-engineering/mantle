/**
 * Durable extractor queue (pg-boss).
 *
 * Replaces the old in-memory debounce (`scheduleExtract` — a 2s setTimeout that
 * collected node ids then fired `extractNode` for ALL of them at once, with no
 * concurrency cap, no retry, and errors swallowed by a bare `.catch`). A burst
 * of 20–30 file inserts therefore launched 20–30 concurrent extractions — each
 * itself a fan-out of summary + embedding + fact-extraction + per-fact
 * classifier LLM calls — and the provider rate-limited the storm. The failures
 * were logged and dropped, so those files silently never got a summary,
 * embedding, or facts.
 *
 * This module solves all three at once with one battle-tested mechanism (the
 * same pg-boss already driving the email/telegram workers, schema `pgboss`):
 *
 *   1. Concurrency cap   — N independent `batchSize:1` workers (pg-boss v10
 *                          dropped teamSize) on the main queue, and one more
 *                          on the heavy lane (point 5). N is the hard ceiling
 *                          on in-flight extractions regardless of how big the
 *                          insert burst is: one in-process ceiling holds the
 *                          N + 1 workers to N runs. Config row →
 *                          `EXTRACT_CONCURRENCY` env → 2, re-read every 30s
 *                          so a UI change is live.
 *   2. Retry w/ backoff  — a transient failure (rate-limit, flaky provider)
 *                          throws out of the handler → pg-boss retries the whole
 *                          job after an exponential-backoff delay. extractNode
 *                          is retry-safe: the already_extracted guard keys on the
 *                          end-of-pass `extract_completed_at` marker, so a retry
 *                          after a partial failure re-runs instead of skipping.
 *   3. Durability        — jobs live in the `pgboss` tables, so a burst survives
 *                          an agent crash/restart. Jobs that exhaust their
 *                          retries land in a dead-letter queue, which is
 *                          RE-DRIVEN on every agent start and surfaced by the
 *                          /debug/integrity dead-letter check — visible AND
 *                          self-healing, not just "not lost".
 *   4. Provider circuit: an ACCOUNT error (no credits, refused key) pauses
 *                          the queue instead of burning every job's retries,
 *                          alerts the admins, probes with backoff, and on
 *                          recovery re-drives the dead letters and sweeps the
 *                          unextracted nodes with no restart
 *                          (provider-circuit.ts, docs/embeddings.md
 *                          "Provider outages").
 *   5. Two lanes         — a drawing (DWG, DXF, DGN, DWF) is a heavy
 *                          extraction. The main worker that takes its job
 *                          sends it on to `mantle.extract.heavy`, where one
 *                          worker runs heavy files one at a time; the main
 *                          workers stay free for light files. Every sender
 *                          still sends to `mantle.extract` only. One ceiling
 *                          holds light and heavy together at N
 *                          (extract-lanes.ts).
 *   6. A run on demand   — a job with `run` (enqueuePipelineRun, sent only
 *                          for a `pipeline_run` notify) builds or patches the
 *                          file's database and does nothing else
 *                          (extract/pipeline-run.ts). It takes the same lanes,
 *                          ceiling and per-node chain; a dead-lettered one is
 *                          never re-driven.
 *
 * Same-node concurrency is excluded by two layers:
 *
 *   - Queue `policy: 'short'` — pg-boss's partial unique index on
 *     (name, singleton_key) WHERE state='created' collapses duplicate
 *     `node_ingested` notifies while a job for that node is still QUEUED.
 *     (`singletonKey` alone does NOTHING on a 'standard' queue — no unique
 *     index covers it; that was the original bug: duplicate notifies created
 *     duplicate jobs, and two workers could run the same node concurrently,
 *     interleaving the delete-then-rebuild writes.)
 *   - In-process per-node chaining — 'short' doesn't cover a job enqueued
 *     while the node's previous job is ACTIVE (the index only covers
 *     'created'); another worker can fetch it immediately. All workers live
 *     in this one process, so a Map<nodeId, Promise> chain serialises runs
 *     per node while keeping the N workers fully parallel across nodes.
 */

import { eq, sql } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import {
  clearEmbeddingModelCache,
  probeConfiguredEmbedding,
  resolveEmbeddingConfig,
  resolveExtractionConcurrency,
  type EmbeddingConfig,
} from '@mantle/embeddings';
import {
  HEADS_DEAD_QUEUE,
  notifyParked,
  parkHeadsFailure,
  stampExtractParked,
} from './extract-heads-park';
import {
  countDeadLetteredExtracts,
  db,
  isProbedSubject,
  listOpenProviderAlerts,
  nodes,
  type ProviderSubject,
  recordProviderFailure,
  recordProviderProbeFailure,
  resolveProviderAlert,
  runAsSystem,
  setProviderAlertPaused,
} from '@mantle/db';
import { extractNode } from './extractor.js';
import {
  ExtractCeiling,
  extractWeightOfNode,
  HEAVY_HOP_OUTPUT,
  HEAVY_LANE_WORKERS,
} from './extract-lanes.js';
import { probeExtractionModel } from './extract/model.js';
import { isAfterRun, runPipelineJob } from './extract/pipeline-run.js';
import { ProviderCircuit } from './provider-circuit.js';
import { envNum } from '@mantle/config';
import { assertNoViewer } from '@mantle/db/viewer';
import { errorMessage } from '@mantle/std';

const EXTRACT_QUEUE = 'mantle.extract';
/** The heavy lane (extract-lanes.ts). Nothing sends to it but the main
 *  queue's own workers. Its failed jobs go to the same dead-letter queue, and
 *  a re-drive from there enters by the main queue again. */
const HEAVY_QUEUE = 'mantle.extract.heavy';
const DEAD_LETTER_QUEUE = 'mantle.extract.dead';

/** How long a worker may hold a single extraction before pg-boss declares the
 *  job expired and retries it. pg-boss defaults to **15 min** — too tight for a
 *  slow/CPU embedder on a bulky document: hundreds of chunks embed serially for
 *  >15 min, so the job expires mid-run, retries, and eventually dead-letters
 *  without ever finishing (the embedding cache lets a retry resume, but on a
 *  slow box it mostly thrashes). 60 min gives a big extraction room to complete
 *  in one clean pass; raise via `MANTLE_EXTRACT_EXPIRE_MIN` on very slow
 *  hardware (a GPU/upgraded box can leave it at the default). */
const EXTRACT_EXPIRE_MIN = envNum('MANTLE_EXTRACT_EXPIRE_MIN');

/** Retry policy lives on the queue so every job inherits it. With backoff the
 *  delays grow ~30s → 60s → 120s → 240s → 480s, spreading rate-limit retries
 *  out over minutes instead of hammering the provider. After 5 failed tries
 *  the job moves to the dead-letter queue. */
const EXTRACT_QUEUE_OPTIONS = {
  policy: 'short' as const,
  retryLimit: 5,
  retryDelay: 30,
  retryBackoff: true,
  expireInSeconds: EXTRACT_EXPIRE_MIN * 60,
  deadLetter: DEAD_LETTER_QUEUE,
};

/** A job of a file. With `run`, a run on demand of that pipeline
 *  (enqueuePipelineRun): it builds or patches the file's database only. */
type ExtractJob = { nodeId: string; run?: string };

/** A job's singleton key: the node, or `<pipeline>:<node>` for a run, so a
 *  run and an extract of one file never collapse into each other. */
const keyOf = (job: ExtractJob): string => (job.run ? `${job.run}:${job.nodeId}` : job.nodeId);

let boss: PgBoss | null = null;

/** Per-node in-flight chain — see the same-node concurrency note above. */
const inflightByNode = new Map<string, Promise<unknown>>();

/** Live worker pool: one pg-boss work id per worker, sized from the config. */
const workerIds: string[] = [];
/** The heavy lane's workers: HEAVY_LANE_WORKERS while the queue runs, none
 *  while it is paused. */
const heavyWorkerIds: string[] = [];
/** Light and heavy together never pass the configured worker count. */
const ceiling = new ExtractCeiling(envNum('EXTRACT_CONCURRENCY'));
let activeOwnerId: string | null = null;
let activeExpireMin = EXTRACT_EXPIRE_MIN;
let reconcileTimer: ReturnType<typeof setInterval> | null = null;
let reconciling = false;
const RECONCILE_INTERVAL_MS = 30_000;

/** The provider circuit (provider-circuit.ts): pauses the queue on a
 *  confirmed account error, probes, and recovers with no restart. */
let circuit: ProviderCircuit | null = null;
/** The embedding routes as last seen, to notice a saved change. */
let routesFingerprint: string | null = null;
/** The unextracted-node sweep the agent runs at boot (runtime.ts), handed in
 *  so a recovery runs the same bounded code path. */
let sweepUnextracted: () => Promise<void> = async () => {};

function fingerprintRoutes(cfg: EmbeddingConfig): string {
  const r = (x: EmbeddingConfig['primary'] | null) =>
    x ? [x.provider, x.baseUrl ?? '', x.apiKeyId ?? ''].join('|') : '-';
  return [cfg.model, r(cfg.primary), r(cfg.backup)].join('#');
}

function buildCircuit(ownerId: string): ProviderCircuit {
  return new ProviderCircuit({
    now: () => Date.now(),
    probe: (subject: ProviderSubject) =>
      subject === 'embedding' ? probeConfiguredEmbedding(ownerId) : probeExtractionModel(ownerId),
    pauseWorkers: async () => {
      await setWorkerCount(0);
    },
    resumeWorkers: async () => {
      const cfg = await resolveEmbeddingConfig(ownerId).catch(() => null);
      await setWorkerCount(resolveExtractionConcurrency(cfg?.extractionConcurrency));
    },
    recover: async () => {
      const redriven = await redriveDeadLetters();
      await sweepUnextracted();
      return { redriven };
    },
    deadLetterCount: countDeadLetteredExtracts,
    store: {
      // The circuit's subjects only: a model_policy alert (0348) is the box
      // policy's and a decision alert (0353) the decider's, never probed or
      // paused here.
      listOpen: async () =>
        (await listOpenProviderAlerts(ownerId))
          .filter((r) => isProbedSubject(r.subject))
          .map((r) => ({
            subject: r.subject as ProviderSubject,
            paused: r.paused,
            visible: r.visible,
            nextProbeAt: r.nextProbeAt,
            probeAttempts: r.probeAttempts,
          })),
      recordFailure: async (subject, cls) => {
        await recordProviderFailure(ownerId, subject, {
          code: cls.code,
          permanent: cls.permanent,
          reason: cls.reason,
        });
      },
      setPaused: (subject, paused, nextProbeAt) =>
        setProviderAlertPaused(ownerId, subject, paused, nextProbeAt),
      probeFailed: (subject, nextProbeAt) =>
        recordProviderProbeFailure(ownerId, subject, nextProbeAt),
      resolve: (subject) => resolveProviderAlert(ownerId, subject),
    },
    log: (msg) => console.log(`[extract-queue] ${msg}`),
  });
}

/**
 * Re-drive dead-lettered extract jobs back onto the main queue. Runs at every
 * agent start, and when the provider circuit recovers (a probe that works, an
 * alert closing, a config save, an admin's "Try again"): a node that exhausted
 * its 5 retries (e.g. the embedder was down all evening) gets a fresh round
 * without a restart, instead of sitting in the DLQ forever with no reader. A genuinely poisoned job cycles
 * back to the DLQ after 5 more failures — bounded per start, and standing
 * visibility comes from the /debug/integrity dead-letter check.
 */
async function redriveDeadLetters(): Promise<number> {
  if (!boss) return 0;
  let total = 0;
  // Bounded sweep: 50 × 20 = 1000 jobs max per start or recovery.
  for (let i = 0; i < 50; i++) {
    const jobs = await boss.fetch<ExtractJob>(DEAD_LETTER_QUEUE, { batchSize: 20 });
    if (!jobs || jobs.length === 0) break;
    for (const job of jobs) {
      // A run on demand is never sent again: nothing starts by itself.
      if (job.data?.nodeId && !job.data.run) {
        await boss.send(EXTRACT_QUEUE, job.data, { singletonKey: job.data.nodeId });
      }
      await boss.complete(DEAD_LETTER_QUEUE, job.id);
      total++;
    }
  }
  return total;
}

/**
 * Start the boss, create the queue (+ dead-letter), and register the workers.
 * Idempotent on the pgboss schema — safe to call alongside the web email worker
 * which shares the same `pgboss` schema.
 */
export async function startExtractQueue(
  databaseUrl: string,
  ownerId: string,
  opts: { sweepUnextracted?: () => Promise<void> } = {},
): Promise<void> {
  if (opts.sweepUnextracted) sweepUnextracted = opts.sweepUnextracted;
  boss = new PgBoss({ connectionString: databaseUrl, schema: 'pgboss' });
  boss.on('error', (err) => console.error('[extract-queue] pg-boss error:', err));
  await boss.start();

  // Resolve the per-owner throughput tuning from the embedding config (null →
  // env → code default). reconcileWithConfig re-reads it every 30s, so a UI
  // change applies without a restart. Best-effort — a DB hiccup falls back to
  // env/default.
  const cfg = await resolveEmbeddingConfig(ownerId).catch(() => null);
  const expireMin =
    cfg?.extractionTimeBudgetMinutes && cfg.extractionTimeBudgetMinutes >= 1
      ? cfg.extractionTimeBudgetMinutes
      : EXTRACT_EXPIRE_MIN;
  const queueOptions = { ...EXTRACT_QUEUE_OPTIONS, expireInSeconds: expireMin * 60 };

  // Dead-letter target first — the main queue references it by name.
  // pg-boss 12 types the options as Omit<Queue,'name'>: the queue name is the
  // first argument, so repeating it in the options object is now rejected.
  await boss.createQueue(DEAD_LETTER_QUEUE, { policy: 'standard' });
  await boss.createQueue(HEADS_DEAD_QUEUE, { policy: 'standard' });

  await boss.createQueue(EXTRACT_QUEUE, queueOptions);
  await boss.createQueue(HEAVY_QUEUE, queueOptions);
  // createQueue is ON CONFLICT DO NOTHING, so an existing queue keeps the
  // settings it was first created with; updateQueue lands the resolved expiry
  // (which the user can change in the UI) on an already-created queue.
  //
  // `policy` MUST NOT be in that payload. pg-boss 12 throws
  // "queue policy cannot be changed after creation" whenever the key is
  // present — unconditionally, even when the value matches what is stored — so
  // passing queueOptions wholesale kills the API at boot on every box.
  // Migrating a pre-existing 'standard' queue to 'short' (the original reason
  // this call existed) is simply not possible in 12; it is also moot, because
  // the 10 → 12 hop drops and rebuilds the pgboss schema, so every queue is
  // created fresh from queueOptions with the right policy above.
  const { policy: _policy, ...mutableQueueOptions } = queueOptions;
  await boss.updateQueue(EXTRACT_QUEUE, mutableQueueOptions);
  await boss.updateQueue(HEAVY_QUEUE, mutableQueueOptions);

  const redriven = await redriveDeadLetters();
  if (redriven > 0) {
    console.log(
      `[extract-queue] re-drove ${redriven} dead-lettered job(s) for a fresh retry round`,
    );
  }

  activeOwnerId = ownerId;
  activeExpireMin = expireMin;
  if (cfg) routesFingerprint = fingerprintRoutes(cfg);

  // An outage that was open when the agent stopped holds the queue paused
  // again, and probes at once (a restart is a "try again" too).
  circuit = buildCircuit(ownerId);
  await circuit.tick().catch((err) => {
    console.error('[extract-queue] circuit start:', err instanceof Error ? err.message : err);
  });
  const concurrency = resolveExtractionConcurrency(cfg?.extractionConcurrency);
  if (!circuit.isPaused()) await setWorkerCount(concurrency);

  // The worker count and the time budget are LIVE: the UI writes the config
  // row from another process, so poll it. Each tick drops the resolver cache
  // first, so a saved change lands within one interval with no restart.
  // Each reconcile tick is the runner's own work.
  reconcileTimer = setInterval(() => {
    void runAsSystem('tick:extract-reconcile', () => reconcileWithConfig());
  }, RECONCILE_INTERVAL_MS);
  reconcileTimer.unref?.();

  console.log(
    `[extract-queue] ${circuit.isPaused() ? `0 worker(s), PAUSED by a provider outage (${concurrency} when it works)` : `${concurrency} worker(s)`} on ${EXTRACT_QUEUE} ` +
      `(policy=short, ${expireMin}min budget, retry 5× w/ backoff → ${DEAD_LETTER_QUEUE}); ` +
      `heavy files ${HEAVY_LANE_WORKERS} at a time on ${HEAVY_QUEUE}`,
  );
}

/** Whether a node's extraction is heavy (extract-lanes.ts). A node that is
 *  gone is light: the extractor finds that out and says so itself. */
async function isHeavyNode(nodeId: string): Promise<boolean> {
  const [row] = await db
    .select({
      type: nodes.type,
      title: nodes.title,
      filename: sql<string | null>`${nodes.data}->>'filename'`,
    })
    .from(nodes)
    .where(eq(nodes.id, nodeId))
    .limit(1);
  return row ? extractWeightOfNode(row) === 'heavy' : false;
}

/** A job of the main queue: a heavy file goes on to the heavy lane, and this
 *  worker is free again at once. The 'short' policy collapses a second hop of
 *  the same node while the first still waits there. */
async function handleMainJob(
  jobs: { data: ExtractJob }[],
): Promise<typeof HEAVY_HOP_OUTPUT | void> {
  const job = jobs[0]?.data;
  // A run of an `after` pipeline stays here: a patch reads no bytes.
  const afterRun = !!job?.run && isAfterRun(job.run);
  if (
    job?.nodeId &&
    !afterRun &&
    boss &&
    heavyWorkerIds.length > 0 &&
    (await isHeavyNode(job.nodeId))
  ) {
    await boss.send(HEAVY_QUEUE, job, { singletonKey: keyOf(job) });
    return HEAVY_HOP_OUTPUT;
  }
  return handleExtractJob(jobs);
}

/** One pg-boss registration per worker: each polls on its own, pg-boss hands
 *  out distinct jobs via SKIP LOCKED, so N workers = up to N concurrent
 *  extractions, each retried independently. batchSize:1 keeps a slow/failing
 *  node from coupling its fate to a batch-mate. */
async function handleExtractJob([job]: { data: ExtractJob }[]): Promise<void> {
  if (!job?.data?.nodeId || !activeOwnerId) return;
  const ownerId = activeOwnerId;
  const { nodeId, run: pipelineId } = job.data;
  // Serialise per node (parallel across nodes) — see module header.
  const prev = inflightByNode.get(nodeId);
  // Under the ceiling: light and heavy together never pass the worker count.
  // The wait for a place is inside the job's time budget (pg-boss counts from
  // the fetch): with N + 1 workers and N places at most one run waits, for
  // one run of another file.
  // A run on demand calls its job and nothing else (pipeline-run.ts): it
  // never throws, so the queue retries it only past its time budget.
  const extract = () =>
    ceiling.run(() =>
      pipelineId
        ? runPipelineJob(ownerId, nodeId, pipelineId).then(() => {})
        : extractNode(nodeId, ownerId),
    );
  const run = prev ? prev.catch(() => {}).then(extract) : extract();
  const tracked: Promise<unknown> = run
    .catch(() => {})
    .finally(() => {
      if (inflightByNode.get(nodeId) === tracked) inflightByNode.delete(nodeId);
    });
  inflightByNode.set(nodeId, tracked);
  // Let it throw: a thrown error propagates to pg-boss and triggers the
  // queue's retry/backoff. A swallowed error is the bug we're fixing.
  try {
    await run;
  } catch (err) {
    // The heads check refused a write (plan V5): parked once, no retry.
    if (
      await parkHeadsFailure(err, nodeId, {
        stamp: stampExtractParked,
        park: boss
          ? async (data) => {
              await boss?.send(HEADS_DEAD_QUEUE, data);
            }
          : null,
        alert: () => notifyParked(ownerId),
        log: (msg) => console.error(`[extract-queue] ${msg}`),
      })
    ) {
      return;
    }
    // An account error (no credits, refused key) pauses the queue once a
    // probe confirms it; anything else retries as before. Not awaited: the
    // confirm probe must not hold this job's failure back from pg-boss.
    void circuit
      ?.onJobError(err)
      .catch((e) => console.error('[extract-queue] circuit:', errorMessage(e)));
    throw err;
  }
}

/** One more worker on a queue of either lane. An extraction is the runner's
 *  own work: this is the one place a job is bound to it. */
function addWorker(
  b: PgBoss,
  queue: string,
  handle: (jobs: { data: ExtractJob }[]) => Promise<unknown>,
): Promise<string> {
  return b.work<ExtractJob>(queue, { batchSize: 1, pollingIntervalSeconds: 2 }, (jobs) =>
    runAsSystem('queue:extract', () => handle(jobs)),
  );
}

/** Grow or shrink the worker pool to `target`. A removed worker stops polling
 *  and finishes the job it holds (offWork without wait), so nothing is cut off
 *  mid-extraction. */
async function setWorkerCount(target: number): Promise<void> {
  if (!boss) return;
  // A paused queue (0) keeps the ceiling it had: the runs in flight finish
  // under it.
  if (target > 0) ceiling.setLimit(target);
  // The heavy lane first, so a main worker never takes a heavy file while
  // the lane has no worker to give it to; and last out, the same way.
  const heavyTarget = target > 0 ? HEAVY_LANE_WORKERS : 0;
  while (heavyWorkerIds.length < heavyTarget) {
    heavyWorkerIds.push(await addWorker(boss, HEAVY_QUEUE, handleExtractJob));
  }
  while (workerIds.length < target) {
    workerIds.push(await addWorker(boss, EXTRACT_QUEUE, handleMainJob));
  }
  while (workerIds.length > target) {
    const id = workerIds.pop();
    if (id) await boss.offWork(EXTRACT_QUEUE, { id, wait: false });
  }
  while (heavyWorkerIds.length > heavyTarget) {
    const id = heavyWorkerIds.pop();
    if (id) await boss.offWork(HEAVY_QUEUE, { id, wait: false });
  }
}

/** Re-read the config and apply a changed worker count or time budget. */
async function reconcileWithConfig(): Promise<void> {
  if (!boss || !activeOwnerId || reconciling) return;
  reconciling = true;
  try {
    clearEmbeddingModelCache(activeOwnerId);
    const cfg = await resolveEmbeddingConfig(activeOwnerId);
    // A saved change to the embedding routes is a reason to try again: probe
    // an open alert now, and recover a waiting backlog (provider-circuit.ts).
    const fp = fingerprintRoutes(cfg);
    if (routesFingerprint !== null && fp !== routesFingerprint) circuit?.requestRecovery('config');
    routesFingerprint = fp;
    await circuit?.tick();
    // A paused queue stays at zero workers until the circuit resumes it.
    const target = circuit?.isPaused()
      ? 0
      : resolveExtractionConcurrency(cfg.extractionConcurrency);
    if (target !== workerIds.length) {
      const from = workerIds.length;
      await setWorkerCount(target);
      console.log(`[extract-queue] workers ${from} → ${target} (config change, no restart)`);
    }
    const expireMin =
      cfg.extractionTimeBudgetMinutes && cfg.extractionTimeBudgetMinutes >= 1
        ? cfg.extractionTimeBudgetMinutes
        : EXTRACT_EXPIRE_MIN;
    if (expireMin !== activeExpireMin) {
      const { policy: _policy, ...mutable } = EXTRACT_QUEUE_OPTIONS;
      await boss.updateQueue(EXTRACT_QUEUE, { ...mutable, expireInSeconds: expireMin * 60 });
      await boss.updateQueue(HEAVY_QUEUE, { ...mutable, expireInSeconds: expireMin * 60 });
      console.log(`[extract-queue] time budget ${activeExpireMin} → ${expireMin} min`);
      activeExpireMin = expireMin;
    }
  } catch (err) {
    console.error('[extract-queue] reconcile error:', err instanceof Error ? err.message : err);
  } finally {
    reconciling = false;
  }
}

/**
 * Enqueue a node for extraction. With the queue's 'short' policy,
 * `singletonKey` collapses duplicate `node_ingested` notifies for the same
 * node while a job is still QUEUED (the coalescing the old 2s debounce gave
 * us); a notify during an ACTIVE run queues exactly one follow-up.
 * Best-effort: a failed enqueue is logged, and the boot-time
 * `drainUnextractedNodes` sweep is the safety net for anything that slips
 * through. No-op if the queue isn't started.
 */
export async function enqueueExtract(nodeId: string): Promise<void> {
  assertNoViewer('enqueueExtract');
  if (!boss || !nodeId) return;
  await boss.send(EXTRACT_QUEUE, { nodeId } satisfies ExtractJob, { singletonKey: nodeId });
}

/**
 * Enqueue a run on demand of one pipeline on one file: the `pipeline_run`
 * notify's job (runtime.ts), and nothing else sends one. Its singleton key
 * is `<pipeline>:<node>`, so a second notify for the same file and
 * pipeline while the first waits sends no second job. A reader's run of a
 * heavy file goes on to the heavy lane as an extract does (handleMainJob);
 * an `after` run stays on this queue. No-op if the queue isn't started.
 */
export async function enqueuePipelineRun(nodeId: string, pipelineId: string): Promise<void> {
  assertNoViewer('enqueuePipelineRun');
  if (!boss || !nodeId || !pipelineId) return;
  const job = { nodeId, run: pipelineId } satisfies ExtractJob;
  await boss.send(EXTRACT_QUEUE, job, { singletonKey: keyOf(job) });
}

/**
 * An admin saved provider settings or pressed "Try again" (the
 * `provider_recover` NOTIFY, runtime.ts): probe open alerts and recover a
 * waiting backlog now, not on the next 30 s tick. Bounded by the circuit's
 * own gaps (provider-circuit.ts).
 */
export function requestProviderRecovery(trigger: 'config' | 'admin'): void {
  if (!circuit) return;
  circuit.requestRecovery(trigger);
  void reconcileWithConfig();
}

/** Gracefully stop the boss (lets in-flight jobs finish). */
export async function stopExtractQueue(): Promise<void> {
  if (reconcileTimer) clearInterval(reconcileTimer);
  reconcileTimer = null;
  workerIds.length = 0;
  heavyWorkerIds.length = 0;
  circuit = null;
  routesFingerprint = null;
  if (!boss) return;
  const b = boss;
  boss = null;
  try {
    await b.stop({ graceful: true });
  } catch (err) {
    console.error('[extract-queue] stop error:', err instanceof Error ? err.message : err);
  }
}
