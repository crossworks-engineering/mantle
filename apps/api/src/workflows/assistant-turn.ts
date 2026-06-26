/**
 * Assistant-turn runner — the real one. Wraps runAssistantTurn (from
 * @mantle/assistant-runtime) as a durable DBOS workflow on the shared `mantle`
 * queue, so a turn runs server-side to completion regardless of the request:
 * navigating away from /assistant no longer kills it, and a process restart
 * resumes via DBOS auto-recovery.
 *
 * GRANULARITY (important): today the whole turn runs as ONE durable step. That
 * already delivers the headline win (execution decoupled from the request) plus
 * queue/concurrency/recovery/run-timing. It does NOT yet give per-tool
 * idempotency: a process crash mid-turn re-runs the entire turn on recovery,
 * which can re-fire side-effecting tools (e.g. re-send an email). True
 * tool-level journaling needs runToolLoop (in @mantle/agent-runtime) instrumented
 * to emit each LLM call + tool dispatch as its own DBOS step — a deliberate
 * later refinement. Because of that, step retries are OFF here: a failed turn
 * surfaces as a failure (Step 5 writes status='failed' on the row), it is not
 * silently replayed.
 */

import { DBOS } from '@dbos-inc/dbos-sdk';
import { runAssistantTurn, type RunAssistantTurnOptions } from '@mantle/assistant-runtime';
import { RUNNER_QUEUE } from '../config';

/** Durable, serializable input for one assistant turn (carried in the DBOS
 *  journal). Mirrors runAssistantTurn's (ownerId, text, options) arguments. */
export type AssistantTurnInput = {
  ownerId: string;
  text: string;
  options?: RunAssistantTurnOptions;
};

/** Compact result kept in the workflow journal. The reply text + artifacts live
 *  on the persisted assistant_messages rows (the client reads them from there /
 *  over SSE), so the journal only needs the row ids. */
export type AssistantTurnRunResult = {
  inboundId: string;
  outboundId: string;
};

async function assistantTurnImpl(input: AssistantTurnInput): Promise<AssistantTurnRunResult> {
  const { ownerId, text, options } = input;
  const surface = options?.channel ?? 'web';

  // Standard runner span tags (see ping.ts) so every runner filters on the same
  // dimensions in traces / run queries.
  DBOS.span?.setAttribute('mantle.runner', 'assistant_turn');
  DBOS.span?.setAttribute('mantle.owner_id', ownerId);
  DBOS.span?.setAttribute('mantle.surface', surface);
  if (options?.agentSlug) DBOS.span?.setAttribute('mantle.agent_slug', options.agentSlug);
  DBOS.logger.info(`[assistant_turn] start (owner=${ownerId}, surface=${surface})`);

  const result = await DBOS.runStep(() => runAssistantTurn(ownerId, text, options), {
    name: 'run_turn',
    retriesAllowed: false,
  });

  DBOS.span?.setAttribute('mantle.reply_chars', result.reply.length);
  DBOS.span?.setAttribute('mantle.artifact_count', result.artifacts.length);
  DBOS.logger.info(
    `[assistant_turn] done (inbound=${result.inbound.id}, outbound=${result.outbound.id}, ` +
      `reply_chars=${result.reply.length})`,
  );
  return { inboundId: result.inbound.id, outboundId: result.outbound.id };
}

export const ASSISTANT_TURN_WORKFLOW = 'assistantTurnWorkflow';
export const assistantTurnWorkflow = DBOS.registerWorkflow(assistantTurnImpl, {
  name: ASSISTANT_TURN_WORKFLOW,
});

/** Enqueue a turn from WITHIN the runner process (runner-side / tests). The web
 *  route enqueues cross-process via DBOSClient instead — Step 5. `workflowID`,
 *  when supplied (e.g. the inbound message id), makes the enqueue idempotent. */
export function enqueueAssistantTurn(
  input: AssistantTurnInput,
  opts?: { workflowID?: string },
) {
  return DBOS.startWorkflow(assistantTurnWorkflow, {
    queueName: RUNNER_QUEUE,
    ...(opts?.workflowID ? { workflowID: opts.workflowID } : {}),
  })(input);
}
