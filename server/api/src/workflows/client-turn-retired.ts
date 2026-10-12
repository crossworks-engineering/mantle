/**
 * The retired client chat turn, kept as a no-op under its old workflow name
 * (workspaces W5c removed the client portal and its chat).
 *
 * The client turn's runner is gone, but a box can hold client turns in its
 * DBOS system database when it upgrades: ENQUEUED on the `mantle.client`
 * queue (that queue's row persists, so the queue runner still dispatches it),
 * or PENDING when the process stopped mid-turn (recovery re-dispatches it).
 * With no function under the name, DBOS logs "Cannot find workflow function"
 * and the turn stays PENDING, to be retried on every boot. This stub takes it
 * instead and returns, so the workflow ends in SUCCESS and never comes back.
 *
 * It reads and writes nothing, and starts no LLM work.
 */
import { DBOS } from '@dbos-inc/dbos-sdk';
import { registerActorWorkflow, systemEntry } from './actor-workflow';
import { RETIRED_CLIENT_TURN_WORKFLOW } from '@mantle/runtime/assistant';

/** The old input, as the client chat route enqueued it. Read defensively: it
 *  comes from a journal written by an older release. */
type RetiredClientTurnInput = { options?: { loginId?: unknown } };

export type RetiredClientTurnResult = { retired: true };

export async function retiredClientTurn(input: unknown): Promise<RetiredClientTurnResult> {
  const loginId = ((input ?? {}) as RetiredClientTurnInput).options?.loginId;
  DBOS.logger.info(
    `[client_turn] retired: a queued client turn ended without running (login=${String(loginId)})`,
  );
  return { retired: true };
}

// Arch A2a: every workflow names its actor; this one sends no statement.
export const retiredClientTurnWorkflow = registerActorWorkflow(
  RETIRED_CLIENT_TURN_WORKFLOW,
  systemEntry('workflow:client-turn-retired'),
  retiredClientTurn,
);
