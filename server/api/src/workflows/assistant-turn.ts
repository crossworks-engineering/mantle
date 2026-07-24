/**
 * Assistant-turn runner — the real one. Wraps runAssistantTurn (from
 * @mantle/assistant-runtime) as a durable DBOS workflow on the shared `mantle`
 * queue, so a turn runs server-side to completion regardless of the request:
 * navigating away from /assistant no longer kills it, and a process restart
 * resumes via DBOS auto-recovery.
 *
 * GRANULARITY: the turn runs under withDurableSteps, so every boundary already
 * marked by @mantle/tracing step() inside runToolLoop (each LLM call + each tool
 * dispatch) plus record_inbound/record_outbound becomes its own journaled DBOS
 * step. A crash mid-turn resumes from the last completed step — completed
 * (side-effecting) tools and row writes are NOT re-run. Nested sub-agent
 * (invoke_agent) loops journal as a single step each for now (the nesting guard
 * keeps DBOS from seeing steps-within-steps); per-tool journaling INSIDE a
 * sub-agent is a later refinement via child workflows. The deterministic glue
 * between steps (prompt building, context shaping) re-executes harmlessly on
 * replay since its outputs only feed step inputs the engine ignores.
 *
 * The web route enqueues this workflow and AWAITS its result (relaying the same
 * response shape it returned when the turn ran in-process); the workflow returns
 * a plain serializable DTO ready for that relay.
 */

import { DBOS } from '@dbos-inc/dbos-sdk';
import { withDurableSteps } from '@mantle/tracing';
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
    // Run the turn with a durable executor active: each already-instrumented
    // boundary inside runAssistantTurn (record_inbound/outbound, and every LLM
    // call + tool dispatch in runToolLoop via @mantle/tracing step()) becomes a
    // journaled DBOS step. So a crash mid-turn resumes from the last completed
    // step — completed tools/rows are NOT re-run. The deterministic glue between
    // steps re-executes harmlessly on replay (its outputs only feed step inputs,
    // which the engine ignores in favour of journaled results).
    //
    // The DTO mapping uses `new Date(...)` because on replay the journaled row's
    // createdAt deserializes to a string, not a Date.
    dto = await withDurableSteps(
      (name, fn) => DBOS.runStep(fn, { name }),
      async (): Promise<AssistantTurnRunResult> => {
        const r = await runAssistantTurn(ownerId, text, options);
        return {
          inbound: {
            id: r.inbound.id,
            text: r.inbound.text,
            createdAt: new Date(r.inbound.createdAt).toISOString(),
          },
          outbound: {
            id: r.outbound.id,
            text: r.outbound.text,
            model: r.outbound.model,
            createdAt: new Date(r.outbound.createdAt).toISOString(),
          },
          reply: r.reply,
          artifacts: r.artifacts,
        };
      },
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
export function enqueueAssistantTurn(input: AssistantTurnInput, opts?: { workflowID?: string }) {
  return DBOS.startWorkflow(assistantTurnWorkflow, {
    queueName: RUNNER_QUEUE,
    ...(opts?.workflowID ? { workflowID: opts.workflowID } : {}),
  })(input);
}
