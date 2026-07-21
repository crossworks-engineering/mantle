/**
 * Runs worker — the pg-boss motor behind runner queues (docs/runs.md; §5b of
 * the implementation plan). Mirrors the maintenance-worker idiom: one process,
 * queues + a cron, graceful shutdown, heartbeat file for the compose
 * healthcheck.
 *
 * Three queues + the sweep:
 *   mantle.run.tool   — tool_call / note items (fast, some concurrency)
 *   mantle.run.worker — worker_invoke items (slice 2 — items currently fail
 *                       with a structured unsupported_kind record)
 *   mantle.run.resume — responder resume turns (LLM; concurrency 1)
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
import PgBoss from 'pg-boss';
import { sql } from 'drizzle-orm';
import { db } from '@mantle/db';
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
import { runResumeTurn } from '../lib/runs/resume';

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

  // Slice 2 lane: whole agent turns. Handler already exists so a stray
  // worker_invoke item fails structured instead of rotting queued.
  await boss.work<DispatchJob>(RUN_WORKER_QUEUE, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      const { actions } = await executeRunItem(job.data.itemId);
      await enqueueRunActionsSafe(actions);
    }
  });

  // Resume turns: one at a time — each is an LLM turn; ordering between runs
  // doesn't matter, memory pressure does.
  await boss.work<ResumeJob>(RUN_RESUME_QUEUE, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      await runResumeTurn(job.data.runId, job.data.groupId);
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
