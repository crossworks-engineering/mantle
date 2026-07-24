/**
 * Runs worker — the pg-boss motor behind runner queues (docs/runs.md; §5b of
 * the implementation plan). Mirrors the maintenance-worker idiom: one process,
 * queues + a cron, graceful shutdown, heartbeat file for the compose
 * healthcheck.
 *
 * Three queues + the sweep:
 *   mantle.run.tool   — tool_call / note items (fast, some concurrency)
 *   mantle.run.worker — worker_invoke items: claim under the per-run cap,
 *                       then hand the whole agent turn to the durable DBOS
 *                       runner in apps/api (slice 3 WP1 — the workflow
 *                       completes the item; this process never runs the LLM)
 *   mantle.run.resume — resume wake-ups: relay to the durable DBOS runner
 *                       (slice 3 WP2 — the LLM turn + claimResume live in
 *                       apps/api; dedup keeps one queued resume per group)
 *   sweep cron        — every minute: deadline timeouts, lost-dispatch and
 *                       lost-resume healing (the engine's immune system)
 *
 * Jobs carry only ids; every handler is a CAS no-op on duplicates. The table
 * is the truth — pg-boss jobs are disposable wake-ups.
 *
 * Feature gate: with MANTLE_RUNS unset the worker stays up (healthcheck
 * green) but registers nothing — flipping the env var and restarting the
 * container brings the engine live.
 */
import { PgBoss } from 'pg-boss';
import { eq, sql } from 'drizzle-orm';
import { db, runItems } from '@mantle/db';
import { startProcessHeartbeat } from '@mantle/content';
import { registerHeartbeatTools } from '@mantle/heartbeats';
import {
  enqueueRunActionsSafe,
  ensureRunQueues,
  isRunsEnabled,
  RUN_RESUME_QUEUE,
  RUN_TOOL_QUEUE,
  RUN_WORKER_QUEUE,
  sweepRuns,
} from '@mantle/runs';

import { executeRunItem } from '../lib/runs/execute-item';
import { enqueueRunsResumeTurn } from '../lib/runs/dbos-enqueue';

const SWEEP_QUEUE = 'mantle.run.sweep';
const SWEEP_CRON = '* * * * *'; // every minute — the sweep is the immune system

// Run-item tool handlers execute in THIS process via dispatchTool; builtins
// register at @mantle/tools import (transitively via execute-item). The
// heartbeat-control builtins live in @mantle/heartbeats and need an explicit
// registration, same as the web/agent processes.
registerHeartbeatTools();

type DispatchJob = { itemId: string };
type ResumeJob = { runId: string; groupId: string };

async function main() {
  startProcessHeartbeat();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must be set');

  if (!isRunsEnabled()) {
    console.log('[runs] MANTLE_RUNS is not set — runner queues disabled; worker idling.');
    // Flag flipped off with runs in flight? Nothing executes AND nothing
    // times out (no sweep) — those runs sit 'running' forever. Cancel them
    // (run_cancel stays live) or re-enable; warn loudly either way.
    try {
      const [{ n }] = (await db.execute(
        sql`SELECT count(*)::int AS n FROM runs WHERE status = 'running'`,
      )) as unknown as [{ n: number }];
      if (n > 0) {
        console.warn(
          `[runs] WARNING: ${n} run(s) still 'running' while MANTLE_RUNS is off — they will ` +
            `not execute, time out, or resume. Cancel them with run_cancel or re-enable the flag.`,
        );
      }
    } catch (err) {
      console.error('[runs] stranded-run check failed:', err);
    }
    return; // heartbeat keeps ticking; compose stays green
  }

  const boss = new PgBoss({ connectionString: url, schema: 'pgboss' });
  boss.on('error', (err) => console.error('[runs] pg-boss:', err));
  await boss.start();
  await ensureRunQueues(boss);
  await boss.createQueue(SWEEP_QUEUE);

  // Fast lane: tool_call / note items. The batch executes CONCURRENTLY —
  // items are typically sub-second tool calls, and the engine's run-row lock
  // ordering makes concurrent completions safe by design (it's the tested
  // invariant). Serial awaiting here would make the "fast lane" concurrency 1.
  await boss.work<DispatchJob>(RUN_TOOL_QUEUE, { batchSize: 5 }, async (jobs) => {
    await Promise.all(
      jobs.map(async (job) => {
        const { actions } = await executeRunItem(job.data.itemId);
        await enqueueRunActionsSafe(actions);
      }),
    );
  });

  // Worker lane (slice 3 WP1): claim-context only. executeRunItem →
  // executeWorkerInvoke claims under the per-run cap and enqueues the turn
  // onto the DBOS RUNNER_QUEUE — the job here is seconds, not a whole LLM
  // turn; an enqueue failure fails the item `dispatch_failed` immediately.
  await boss.work<DispatchJob>(RUN_WORKER_QUEUE, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      const { actions } = await executeRunItem(job.data.itemId);
      await enqueueRunActionsSafe(actions);
    }
  });

  // Resume lane (slice 3 WP2): claim-context only. The LLM turn runs as a
  // durable DBOS workflow in apps/api (claimResume journaled AFTER its
  // preconditions there); this handler just relays the wake-up. The old
  // batchSize-1 serialization stops mattering — RUNNER_QUEUE's concurrency
  // is the LLM backpressure cap now. An enqueue failure just acks: the row
  // still has resumed_at NULL, so the sweep re-sends (the §5b containment
  // story — unlike worker items there is nothing to fail here).
  await boss.work<ResumeJob>(RUN_RESUME_QUEUE, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      const { runId, groupId } = job.data;
      // Cheap duplicate check; the workflow's journaled claimResume CAS is
      // the real gate.
      const [target] = await db
        .select({ resumedAt: runItems.resumedAt })
        .from(runItems)
        .where(eq(runItems.id, groupId));
      if (!target || target.resumedAt) continue;
      try {
        await enqueueRunsResumeTurn(runId, groupId);
      } catch (err) {
        console.error(
          `[runs] resume enqueue failed (run ${runId}, group ${groupId}) — sweep will re-send:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  });

  await boss.schedule(SWEEP_QUEUE, SWEEP_CRON, undefined, { tz: 'UTC' });
  await boss.work(SWEEP_QUEUE, async () => {
    const res = await sweepRuns(db);
    if (res.timedOut || res.redispatched || res.resumesResent) {
      console.log(
        `[runs] sweep: ${res.timedOut} timed out, ${res.redispatched} re-dispatched, ` +
          `${res.resumesResent} resumes re-sent`,
      );
    }
    await enqueueRunActionsSafe(res.actions);
  });

  console.log(
    `[runs] worker up — queues ${RUN_TOOL_QUEUE}, ${RUN_WORKER_QUEUE}, ${RUN_RESUME_QUEUE}; ` +
      `sweep '${SWEEP_CRON}' (UTC)`,
  );

  const shutdown = async () => {
    console.log('[runs] shutting down…');
    await boss.stop({ graceful: true, timeout: 10_000 });
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Keep-alive backstop (the maintenance worker's rationale): a stray rejection
// logs instead of crash-looping the container.
process.on('unhandledRejection', (reason) => {
  console.error('[runs] unhandledRejection (kept alive):', reason);
});

main().catch((err) => {
  console.error('[runs] fatal:', err);
  process.exit(1);
});
