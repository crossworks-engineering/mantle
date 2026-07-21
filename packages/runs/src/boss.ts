/**
 * pg-boss enqueue side of the engine — turns `PostCommitAction[]` into jobs.
 *
 * The engine returns actions instead of enqueuing inside its transactions
 * (pg-boss must never observe uncommitted state); every caller — the run_*
 * tools in the web/api processes, the runs worker's handlers, the sweep —
 * funnels through {@link enqueueRunActions} after commit. Failures here are
 * survivable by design: a lost enqueue is healed by the sweep re-emitting the
 * action, and duplicates no-op at the engine's CAS transitions. The table is
 * the truth; jobs are disposable wake-ups.
 *
 * One lazy singleton `PgBoss` per process (send-only here; the runs worker
 * additionally calls `work()` on its own instance). Queues are created
 * idempotently on first use — pg-boss v10 requires a queue to exist before
 * `send`, and the web process may enqueue before the worker ever booted.
 */
import PgBoss from 'pg-boss';

import type { PostCommitAction } from './engine';
import { RUN_RESUME_QUEUE, RUN_TOOL_QUEUE, RUN_WORKER_QUEUE } from './queues';

let bossPromise: Promise<PgBoss> | null = null;

/** Create the three run queues (idempotent). Shared by the send path below
 *  and the runs worker's boot. */
export async function ensureRunQueues(boss: PgBoss): Promise<void> {
  await boss.createQueue(RUN_TOOL_QUEUE);
  await boss.createQueue(RUN_WORKER_QUEUE);
  await boss.createQueue(RUN_RESUME_QUEUE);
}

async function getSendBoss(): Promise<PgBoss> {
  if (!bossPromise) {
    bossPromise = (async () => {
      const url = process.env.DATABASE_URL;
      if (!url) throw new Error('enqueueRunActions: DATABASE_URL must be set');
      const boss = new PgBoss({ connectionString: url, schema: 'pgboss' });
      boss.on('error', (err) => console.error('[runs] pg-boss (send):', err));
      await boss.start();
      await ensureRunQueues(boss);
      return boss;
    })();
    // A failed init must not poison the process forever — retry next call.
    bossPromise.catch(() => {
      bossPromise = null;
    });
  }
  return bossPromise;
}

/**
 * Enqueue the post-commit actions an engine call returned. Jobs carry only
 * ids — never payload. Resume jobs are `singletonKey`ed by group id (the
 * double-fire backstop); side-effecting dispatches get transport
 * `retryLimit: 0` (§5b — exempt from both retry layers).
 */
export async function enqueueRunActions(actions: readonly PostCommitAction[]): Promise<void> {
  if (actions.length === 0) return;
  const boss = await getSendBoss();
  for (const a of actions) {
    if (a.type === 'dispatch') {
      await boss.send(
        a.queue,
        { itemId: a.itemId },
        a.sideEffecting ? { retryLimit: 0 } : { retryLimit: 2, retryDelay: 5, retryBackoff: true },
      );
    } else {
      await boss.send(
        RUN_RESUME_QUEUE,
        { runId: a.runId, groupId: a.groupId },
        { singletonKey: a.groupId, retryLimit: 2, retryDelay: 10, retryBackoff: true },
      );
    }
  }
}

/** Best-effort variant for paths where the row state is already committed and
 *  the sweep is the safety net (i.e. every caller). Logs and swallows. */
export async function enqueueRunActionsSafe(actions: readonly PostCommitAction[]): Promise<void> {
  try {
    await enqueueRunActions(actions);
  } catch (err) {
    console.error(
      '[runs] enqueue failed (sweep will heal):',
      err instanceof Error ? err.message : err,
    );
  }
}
