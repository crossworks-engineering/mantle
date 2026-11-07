/**
 * Team-turn runner — wraps runTeamTurn (@mantle/runtime/assistant) as a durable
 * DBOS workflow on the shared `mantle` queue, exactly like assistant-turn.ts
 * does for the owner surface. The member chat (POST /api/member/chat) is its
 * one enqueuer. A member's turn survives navigation and process restarts;
 * every LLM call + tool dispatch journals as its own step.
 *
 * Its result is ids and status only, never the text of the turn: the
 * Runners screen shows a run's output to every Admin user, and a member's
 * reply may quote what only the member reads (a reply marked used_private,
 * docs/agent-ui.md). The reply itself is the thread's row.
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
import { registerActorWorkflow } from './actor-workflow';
import { loginActorNow } from './login-actor';
import { withRunWindow } from './turn-window';
import { teamTurnResultOf } from './team-turn-result';

export type { TeamTurnInput, TeamTurnRunResult };

async function teamTurnImpl(input: TeamTurnInput): Promise<TeamTurnRunResult> {
  const { ownerId, text } = input;
  // A Runners restart or fork runs with no window (turn-window.ts).
  const options = withRunWindow(input.options, DBOS.workflowID);

  DBOS.span?.setAttribute('mantle.runner', 'team_turn');
  DBOS.span?.setAttribute('mantle.owner_id', ownerId);
  DBOS.span?.setAttribute('mantle.surface', 'team');
  DBOS.span?.setAttribute('mantle.login_id', options.loginId);
  const who = `login=${options.loginId}`;
  DBOS.logger.info(`[team_turn] start (owner=${ownerId}, ${who})`);

  let dto: TeamTurnRunResult;
  try {
    dto = await withDurableSteps(
      (name, fn) => DBOS.runStep(fn, { name }),
      async (): Promise<TeamTurnRunResult> => {
        const r = await runTeamTurn(ownerId, text, options);
        return teamTurnResultOf(r);
      },
    );
  } catch (err) {
    const msg = errorMessage(err);
    DBOS.span?.setAttribute('mantle.error', msg);
    DBOS.logger.error(`[team_turn] FAILED (owner=${ownerId}, ${who}): ${msg}`);
    throw err;
  }

  DBOS.logger.info(
    `[team_turn] done (inbound=${dto.inbound.id}, outbound=${dto.outbound.id}, reply_chars=${dto.replyChars})`,
  );
  return dto;
}

/** The turn runs as the member login it answers, as it is now. */
export const teamTurnWorkflow = registerActorWorkflow(
  TEAM_TURN_WORKFLOW,
  (input: TeamTurnInput) => loginActorNow(input.options.loginId, 'workflow:team-turn'),
  teamTurnImpl,
);
