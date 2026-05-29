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
 *                          is. `EXTRACT_CONCURRENCY` env (default 2).
 *   2. Retry w/ backoff  — a transient failure (rate-limit, flaky provider)
 *                          throws out of the handler → pg-boss retries the whole
 *                          job after an exponential-backoff delay. extractNode
 *                          is idempotent (re-extract guard), so a retry is safe.
 *   3. Durability        — jobs live in the `pgboss` tables, so a burst survives
 *                          an agent crash/restart. Jobs that exhaust their
 *                          retries land in a dead-letter queue (visible, not
 *                          lost) rather than vanishing.
 *
 * Coalescing (the one thing the debounce did well — collapsing duplicate
 * `node_ingested` notifies for the same node) is preserved via `singletonKey`.
 */

import PgBoss from 'pg-boss';
import { extractNode } from './extractor.js';

const EXTRACT_QUEUE = 'mantle.extract';
const DEAD_LETTER_QUEUE = 'mantle.extract.dead';
const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 8;

type ExtractJob = { nodeId: string };

let boss: PgBoss | null = null;

/** Resolve the worker concurrency from `EXTRACT_CONCURRENCY` (clamped 1..8). */
function resolveConcurrency(): number {
  const raw = process.env.EXTRACT_CONCURRENCY;
  if (!raw) return DEFAULT_CONCURRENCY;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_CONCURRENCY;
  return Math.min(n, MAX_CONCURRENCY);
}

/**
 * Start the boss, create the queue (+ dead-letter), and register the workers.
 * Idempotent on the pgboss schema — safe to call alongside the web email worker
 * which shares the same `pgboss` schema.
 */
export async function startExtractQueue(databaseUrl: string, ownerId: string): Promise<void> {
  boss = new PgBoss({ connectionString: databaseUrl, schema: 'pgboss' });
  boss.on('error', (err) => console.error('[extract-queue] pg-boss error:', err));
  await boss.start();

  // Dead-letter target first — the main queue references it by name.
  await boss.createQueue(DEAD_LETTER_QUEUE, { name: DEAD_LETTER_QUEUE, policy: 'standard' });

  // Retry policy lives on the queue so every job inherits it. With backoff the
  // delays grow ~30s → 60s → 120s → 240s → 480s, spreading rate-limit retries
  // out over minutes instead of hammering the provider. After 5 failed tries
  // the job moves to the dead-letter queue.
  await boss.createQueue(EXTRACT_QUEUE, {
    name: EXTRACT_QUEUE,
    policy: 'standard',
    retryLimit: 5,
    retryDelay: 30,
    retryBackoff: true,
    deadLetter: DEAD_LETTER_QUEUE,
  });

  const concurrency = resolveConcurrency();
  for (let i = 0; i < concurrency; i++) {
    // Each registration is its own polling worker; pg-boss hands out distinct
    // jobs via SKIP LOCKED, so N workers = up to N concurrent extractions, each
    // retried independently. batchSize:1 keeps a slow/failing node from
    // coupling its fate to a batch-mate.
    await boss.work<ExtractJob>(
      EXTRACT_QUEUE,
      { batchSize: 1, pollingIntervalSeconds: 2 },
      async ([job]) => {
        if (!job?.data?.nodeId) return;
        // Let it throw: a thrown error propagates to pg-boss and triggers the
        // queue's retry/backoff. A swallowed error is the bug we're fixing.
        await extractNode(job.data.nodeId, ownerId);
      },
    );
  }

  console.log(
    `[extract-queue] ${concurrency} worker(s) on ${EXTRACT_QUEUE} (retry 5× w/ backoff → ${DEAD_LETTER_QUEUE})`,
  );
}

/**
 * Enqueue a node for extraction. `singletonKey` collapses duplicate
 * `node_ingested` notifies for the same node while a job is still queued/active
 * (the coalescing the old 2s debounce gave us). Best-effort: a failed enqueue
 * is logged, and the boot-time `drainUnextractedNodes` sweep is the safety net
 * for anything that slips through. No-op if the queue isn't started.
 */
export async function enqueueExtract(nodeId: string): Promise<void> {
  if (!boss || !nodeId) return;
  await boss.send(EXTRACT_QUEUE, { nodeId } satisfies ExtractJob, { singletonKey: nodeId });
}

/** Gracefully stop the boss (lets in-flight jobs finish). */
export async function stopExtractQueue(): Promise<void> {
  if (!boss) return;
  const b = boss;
  boss = null;
  try {
    await b.stop({ graceful: true });
  } catch (err) {
    console.error('[extract-queue] stop error:', err instanceof Error ? err.message : err);
  }
}
