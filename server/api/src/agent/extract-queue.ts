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
 *                          dropped teamSize). N is the hard ceiling on in-flight
 *                          extractions regardless of how big the insert burst
 *                          is. Config row → `EXTRACT_CONCURRENCY` env → 2,
 *                          re-read every 30s so a UI change is live.
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
  listOpenProviderAlerts,
  type ProviderSubject,
  recordProviderFailure,
  recordProviderProbeFailure,
  resolveProviderAlert,
  setProviderAlertPaused,
} from '@mantle/db';
import { extractNode } from './extractor.js';
import { probeExtractionModel } from './extract/model.js';
import { ProviderCircuit } from './provider-circuit.js';
import { env } from '@mantle/config';
import { assertNoViewer } from '@mantle/db/viewer';

const EXTRACT_QUEUE = 'mantle.extract';
const DEAD_LETTER_QUEUE = 'mantle.extract.dead';

/** How long a worker may hold a single extraction before pg-boss declares the
 *  job expired and retries it. pg-boss defaults to **15 min** — too tight for a
 *  slow/CPU embedder on a bulky document: hundreds of chunks embed serially for
 *  >15 min, so the job expires mid-run, retries, and eventually dead-letters
 *  without ever finishing (the embedding cache lets a retry resume, but on a
 *  slow box it mostly thrashes). 60 min gives a big extraction room to complete
 *  in one clean pass; raise via `MANTLE_EXTRACT_EXPIRE_MIN` on very slow
 *  hardware (a GPU/upgraded box can leave it at the default). */
const EXTRACT_EXPIRE_MIN = Number(env('MANTLE_EXTRACT_EXPIRE_MIN')) || 60;

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

type ExtractJob = { nodeId: string };

let boss: PgBoss | null = null;

/** Per-node in-flight chain — see the same-node concurrency note above. */
const inflightByNode = new Map<string, Promise<unknown>>();

/** Live worker pool: one pg-boss work id per worker, sized from the config. */
const workerIds: string[] = [];
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
      listOpen: async () =>
        (await listOpenProviderAlerts(ownerId)).map((r) => ({
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
      if (job.data?.nodeId) {
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
  reconcileTimer = setInterval(() => {
    void reconcileWithConfig();
  }, RECONCILE_INTERVAL_MS);
  reconcileTimer.unref?.();

  console.log(
    `[extract-queue] ${circuit.isPaused() ? `0 worker(s), PAUSED by a provider outage (${concurrency} when it works)` : `${concurrency} worker(s)`} on ${EXTRACT_QUEUE} ` +
      `(policy=short, ${expireMin}min budget, retry 5× w/ backoff → ${DEAD_LETTER_QUEUE})`,
  );
}

/** One pg-boss registration per worker: each polls on its own, pg-boss hands
 *  out distinct jobs via SKIP LOCKED, so N workers = up to N concurrent
 *  extractions, each retried independently. batchSize:1 keeps a slow/failing
 *  node from coupling its fate to a batch-mate. */
async function handleExtractJob([job]: { data: ExtractJob }[]): Promise<void> {
  if (!job?.data?.nodeId || !activeOwnerId) return;
  const ownerId = activeOwnerId;
  const { nodeId } = job.data;
  // Serialise per node (parallel across nodes) — see module header.
  const prev = inflightByNode.get(nodeId);
  const run = prev
    ? prev.catch(() => {}).then(() => extractNode(nodeId, ownerId))
    : extractNode(nodeId, ownerId);
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
      .catch((e) =>
        console.error('[extract-queue] circuit:', e instanceof Error ? e.message : String(e)),
      );
    throw err;
  }
}

/** Grow or shrink the worker pool to `target`. A removed worker stops polling
 *  and finishes the job it holds (offWork without wait), so nothing is cut off
 *  mid-extraction. */
async function setWorkerCount(target: number): Promise<void> {
  if (!boss) return;
  while (workerIds.length < target) {
    const id = await boss.work<ExtractJob>(
      EXTRACT_QUEUE,
      { batchSize: 1, pollingIntervalSeconds: 2 },
      handleExtractJob,
    );
    workerIds.push(id);
  }
  while (workerIds.length > target) {
    const id = workerIds.pop();
    if (id) await boss.offWork(EXTRACT_QUEUE, { id, wait: false });
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
