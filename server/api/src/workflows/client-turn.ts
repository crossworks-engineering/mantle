/**
 * Client-turn runner (client logins C4): wraps runClientTurn
 * (@mantle/runtime/assistant) as a durable DBOS workflow on the client queue
 * (CLIENT_TURN_QUEUE, partitioned by login). The client chat
 * (POST /api/client/chat) is its one enqueuer. Its own workflow, not the team
 * one with a role flag: which engine runs is decided here, never by the
 * queued input.
 */

import { DBOS } from '@dbos-inc/dbos-sdk';
import { withDurableSteps } from '@mantle/tracing';
import {
  runClientTurn,
  CLIENT_TURN_WORKFLOW,
  type ClientTurnInput,
  type TeamTurnRunResult,
} from '@mantle/runtime/assistant';
import { errorMessage } from '@mantle/std';

export type { ClientTurnInput };

async function clientTurnImpl(input: ClientTurnInput): Promise<TeamTurnRunResult> {
  const { ownerId, text, options } = input;

  DBOS.span?.setAttribute('mantle.runner', 'client_turn');
  DBOS.span?.setAttribute('mantle.owner_id', ownerId);
  DBOS.span?.setAttribute('mantle.surface', 'client');
  DBOS.span?.setAttribute('mantle.login_id', options.loginId);
  const who = `login=${options.loginId}`;
  DBOS.logger.info(`[client_turn] start (owner=${ownerId}, ${who})`);

  let dto: TeamTurnRunResult;
  try {
    dto = await withDurableSteps(
      (name, fn) => DBOS.runStep(fn, { name }),
      async (): Promise<TeamTurnRunResult> => {
        const r = await runClientTurn(ownerId, text, options);
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
            traceId: r.outbound.traceId ?? null,
            createdAt: new Date(r.outbound.createdAt).toISOString(),
          },
          reply: r.reply,
        };
      },
    );
  } catch (err) {
    const msg = errorMessage(err);
    DBOS.span?.setAttribute('mantle.error', msg);
    DBOS.logger.error(`[client_turn] FAILED (owner=${ownerId}, ${who}): ${msg}`);
    throw err;
  }

  DBOS.logger.info(
    `[client_turn] done (inbound=${dto.inbound.id}, outbound=${dto.outbound.id}, reply_chars=${dto.reply.length})`,
  );
  return dto;
}

export const clientTurnWorkflow = DBOS.registerWorkflow(clientTurnImpl, {
  name: CLIENT_TURN_WORKFLOW,
});
