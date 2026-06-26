/**
 * Assistant-turn runner — the real one. Wraps runAssistantTurn (from
 * @mantle/assistant-runtime) as a durable DBOS workflow on the shared `mantle`
 * queue, so a turn runs server-side to completion regardless of the request:
 * navigating away from /assistant no longer kills it, and a process restart
 * resumes via DBOS auto-recovery.
 *
 * GRANULARITY (important): today the whole turn runs as ONE durable step. That
 * already delivers the headline win (execution moves onto this dedicated service
 * and survives a web-process restart via DBOS recovery) plus
 * queue/concurrency/run-timing. It does NOT yet give per-tool idempotency: a
 * process crash mid-turn re-runs the entire turn on recovery, which can re-fire
 * side-effecting tools (e.g. re-send an email). True tool-level journaling needs
 * runToolLoop (in @mantle/agent-runtime) instrumented to emit each LLM call +
 * tool dispatch as its own DBOS step — a deliberate later refinement. Because of
 * that, step retries are OFF here: a failed turn surfaces as a failure, it is
 * not silently replayed.
 *
 * The web route enqueues this workflow and AWAITS its result (relaying the same
 * response shape it returned when the turn ran in-process), so the step returns
 * a plain serializable DTO ready for that relay.
 */

import { DBOS } from '@dbos-inc/dbos-sdk';
import {
  runAssistantTurn,
  ASSISTANT_TURN_WORKFLOW,
  RUNNER_QUEUE,
  type AssistantTurnInput,
  type AssistantTurnRunResult,
} from '@mantle/assistant-runtime';

export type { AssistantTurnInput, AssistantTurnRunResult };

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

  let dto: AssistantTurnRunResult;
  try {
    // Map to the serializable DTO INSIDE the step so what gets journaled (and
    // returned to the route) is plain JSON — dates stringified, rows reduced to
    // what the chat UI needs — with no Date round-trip surprises.
    dto = await DBOS.runStep(
      async (): Promise<AssistantTurnRunResult> => {
        const r = await runAssistantTurn(ownerId, text, options);
        return {
          inbound: {
            id: r.inbound.id,
            text: r.inbound.text,
            createdAt: r.inbound.createdAt.toISOString(),
          },
          outbound: {
            id: r.outbound.id,
            text: r.outbound.text,
            model: r.outbound.model,
            createdAt: r.outbound.createdAt.toISOString(),
          },
          reply: r.reply,
          artifacts: r.artifacts,
        };
      },
      { name: 'run_turn', retriesAllowed: false },
    );
  } catch (err) {
    // The DBOS run record already captures status=ERROR + the error; add an
    // explicit, queryable failure log + span attribute so "which runs had
    // issues and why" is answerable without digging into the journal. The error
    // re-throws so the workflow lands in ERROR and the route's getResult()
    // rejects — the web layer surfaces it as the turn's error.
    const msg = err instanceof Error ? err.message : String(err);
    DBOS.span?.setAttribute('mantle.error', msg);
    DBOS.logger.error(`[assistant_turn] FAILED (owner=${ownerId}, surface=${surface}): ${msg}`);
    throw err;
  }

  DBOS.span?.setAttribute('mantle.reply_chars', dto.reply.length);
  DBOS.span?.setAttribute('mantle.artifact_count', dto.artifacts.length);
  DBOS.logger.info(
    `[assistant_turn] done (inbound=${dto.inbound.id}, outbound=${dto.outbound.id}, ` +
      `reply_chars=${dto.reply.length})`,
  );
  return dto;
}

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
