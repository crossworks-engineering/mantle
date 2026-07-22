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
import { notifyPendingCreated } from './notify';
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
/**
 * The approval fan-out half of a batch, AWAITED. For callers that need to
 * know it happened — specifically a DBOS workflow, which wraps this in a
 * journaled step so a crash-recovery replay serves the recorded result
 * instead of re-sending the Telegram card / device push. Unlike `dispatch`
 * and `resume`, a notice has no CAS to no-op against, so replay-safety has to
 * come from the journal.
 *
 * Everywhere else, use `enqueueRunActions` — it fires the same notices
 * DETACHED, which is what keeps a hung Telegram request off the settle path.
 */
export async function runPendingNotices(actions: readonly PostCommitAction[]): Promise<void> {
  for (const a of actions) {
    if (a.type !== 'pending_created') continue;
    await notifyPendingCreated({
      ownerId: a.ownerId,
      pendingId: a.pendingId,
      toolSlug: a.toolSlug,
      args: a.args,
    });
  }
}

/** The queue-job half of a batch. Pairs with {@link runPendingNotices} for
 *  callers that handle the two halves separately. */
export async function enqueueRunJobs(actions: readonly PostCommitAction[]): Promise<void> {
  const jobs = actions.filter(
    (a): a is Exclude<PostCommitAction, { type: 'pending_created' }> =>
      a.type !== 'pending_created',
  );
  if (jobs.length === 0) return;
  const boss = await getSendBoss();
  for (const a of jobs) {
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

/** Best-effort {@link enqueueRunJobs} — same swallow-and-log contract as
 *  {@link enqueueRunActionsSafe}; the sweep is the backstop. */
export async function enqueueRunJobsSafe(actions: readonly PostCommitAction[]): Promise<void> {
  try {
    await enqueueRunJobs(actions);
  } catch (err) {
    console.error(
      '[runs] enqueue failed (sweep will heal):',
      err instanceof Error ? err.message : err,
    );
  }
}

export async function enqueueRunActions(actions: readonly PostCommitAction[]): Promise<void> {
  if (actions.length === 0) return;
  // The approval fan-out is not a queue job — it runs without touching
  // pg-boss, so a question is still announced on a brain whose boss
  // connection is sick.
  //
  // DETACHED ON PURPOSE (`void`, the tool-loop's idiom — see
  // notifyPendingCreated's caller in @mantle/agent-runtime). This function is
  // awaited from `settleAskHuman` BEFORE it writes the settle receipt
  // (`executed_at`), and the fan-out ends in a Telegram `sendMessage` whose
  // client default timeout is 500 s. Awaited, one unreachable Telegram API
  // call would hold an answered question in the decided-but-unsettled state
  // past the sweep's 3-minute janitor, which reverts it with "the decision
  // was interrupted before it applied" — about a decision that DID apply. It
  // would also stall the run.tool worker lane and any interactive `run_plan`
  // call. The notice is advisory; the row is the truth.
  // `notifyPendingCreated` never rejects (it try/catches internally), so this
  // floating promise cannot raise an unhandled rejection.
  for (const a of actions) {
    if (a.type !== 'pending_created') continue;
    void notifyPendingCreated({
      ownerId: a.ownerId,
      pendingId: a.pendingId,
      toolSlug: a.toolSlug,
      args: a.args,
    });
  }
  await enqueueRunJobs(actions);
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
