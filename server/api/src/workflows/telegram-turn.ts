/**
 * Telegram-turn runner — wraps the absorbed agent's `handleTelegramMessage`
 * (the responder turn for one inbound Telegram message) as a durable DBOS
 * workflow on the shared `mantle` queue, mirroring the assistant-turn runner.
 *
 * Why durable: the turn used to run inline in the `telegram_message_inserted`
 * LISTEN handler, so a process restart mid-reply lost the work (the old code
 * leaned on an atomic processed-claim + a boot-time drain to avoid duplicates,
 * at the cost of dropping a reply on a crash). As a workflow it instead RESUMES
 * via DBOS auto-recovery from the last completed step.
 *
 * GRANULARITY: like the assistant turn, the body runs under withDurableSteps, so
 * every @mantle/tracing step() inside handleTelegramMessage (attachment
 * download/extract, voice transcription, the tool loop, send_telegram,
 * persist_outbound) plus the two runDurableStep boundaries (the atomic claim and
 * the inbound recordTurn) is a journaled step. A crash mid-turn resumes from the
 * last completed step — the already-sent Telegram message and persisted rows are
 * NOT re-run. The deterministic glue between steps re-executes harmlessly on
 * replay (its outputs only feed step inputs the engine ignores).
 *
 * workflowID = the inbound message id, so a duplicate notify (or a boot-drain
 * enqueue racing the live notify) dedups to the same run.
 */

import { DBOS } from '@dbos-inc/dbos-sdk';
import { withDurableSteps } from '@mantle/tracing';
import { RUNNER_QUEUE } from '@mantle/assistant-runtime';
import { handleTelegramMessage } from '../agent/runtime';

/** DBOS workflow name the runner registers under. Internal to apps/api — the
 *  only enqueuer is this process's own LISTEN handler + boot drain, so unlike
 *  the assistant turn it needs no cross-package contract. */
export const TELEGRAM_TURN_WORKFLOW = 'telegramTurnWorkflow';

export type TelegramTurnInput = { messageId: string };

async function telegramTurnImpl(input: TelegramTurnInput): Promise<void> {
  const { messageId } = input;
  // Standard runner span tags (see ping.ts / assistant-turn.ts) so every runner
  // filters on the same dimensions in traces / run queries.
  DBOS.span?.setAttribute('mantle.runner', 'telegram_turn');
  DBOS.span?.setAttribute('mantle.message_id', messageId);
  DBOS.logger.info(`[telegram_turn] start (message=${messageId})`);

  try {
    await withDurableSteps(
      (name, fn) => DBOS.runStep(fn, { name }),
      () => handleTelegramMessage(messageId),
    );
  } catch (err) {
    // The DBOS run record already captures status=ERROR + the error; add an
    // explicit, queryable failure log + span attribute. Re-throw so the run
    // lands in ERROR (and DBOS won't mark it complete).
    const msg = err instanceof Error ? err.message : String(err);
    DBOS.span?.setAttribute('mantle.error', msg);
    DBOS.logger.error(`[telegram_turn] FAILED (message=${messageId}): ${msg}`);
    throw err;
  }

  DBOS.logger.info(`[telegram_turn] done (message=${messageId})`);
}

export const telegramTurnWorkflow = DBOS.registerWorkflow(telegramTurnImpl, {
  name: TELEGRAM_TURN_WORKFLOW,
});

/** Enqueue a Telegram responder turn on the shared runner queue. `workflowID =
 *  messageId` makes a duplicate enqueue (re-notify, or boot-drain vs. live
 *  notify) idempotent — DBOS dedups to the single existing run. */
export function enqueueTelegramTurn(messageId: string) {
  return DBOS.startWorkflow(telegramTurnWorkflow, {
    queueName: RUNNER_QUEUE,
    workflowID: messageId,
  })({ messageId });
}
