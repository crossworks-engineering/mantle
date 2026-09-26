/**
 * Team-turn runner — wraps runTeamTurn (@mantle/runtime/assistant) as a durable
 * DBOS workflow on the shared `mantle` queue, exactly like assistant-turn.ts
 * does for the owner surface. A member's turn survives navigation and process
 * restarts; every LLM call + tool dispatch journals as its own step.
 */

import { DBOS } from '@dbos-inc/dbos-sdk';
import { withDurableSteps } from '@mantle/tracing';
import {
  runTeamTurn,
  TEAM_TURN_WORKFLOW,
  type TeamTurnInput,
  type TeamTurnRunResult,
} from '@mantle/runtime/assistant';
import { errorMessage } from '@mantle/std';

export type { TeamTurnInput, TeamTurnRunResult };

async function teamTurnImpl(input: TeamTurnInput): Promise<TeamTurnRunResult> {
  const { ownerId, text, options } = input;

  DBOS.span?.setAttribute('mantle.runner', 'team_turn');
  DBOS.span?.setAttribute('mantle.owner_id', ownerId);
  DBOS.span?.setAttribute('mantle.surface', 'team');
  // A member login's turn has no contact (users are the team): name the login.
  if (options.contactId) DBOS.span?.setAttribute('mantle.contact_id', options.contactId);
  if (options.loginId) DBOS.span?.setAttribute('mantle.login_id', options.loginId);
  const who = options.loginId ? `login=${options.loginId}` : `contact=${options.contactId}`;
  DBOS.logger.info(`[team_turn] start (owner=${ownerId}, ${who})`);

  let dto: TeamTurnRunResult;
  try {
    dto = await withDurableSteps(
      (name, fn) => DBOS.runStep(fn, { name }),
      async (): Promise<TeamTurnRunResult> => {
        const r = await runTeamTurn(ownerId, text, options);
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
    DBOS.logger.error(`[team_turn] FAILED (owner=${ownerId}, ${who}): ${msg}`);
    throw err;
  }

  DBOS.logger.info(
    `[team_turn] done (inbound=${dto.inbound.id}, outbound=${dto.outbound.id}, reply_chars=${dto.reply.length})`,
  );
  return dto;
}

export const teamTurnWorkflow = DBOS.registerWorkflow(teamTurnImpl, {
  name: TEAM_TURN_WORKFLOW,
});
