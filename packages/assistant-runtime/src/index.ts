/**
 * @mantle/assistant-runtime — full conversational-turn execution on the unified
 * per-(owner, agent) stream, one layer above @mantle/agent-runtime (which owns
 * the low-level tool loop). Sits here, not in agent-runtime, because a turn
 * needs @mantle/heartbeats + @mantle/content and heartbeats already depends on
 * agent-runtime (so agent-runtime can't depend back on it). Imported by the web
 * route today and the durable apps/api runner next.
 */

export {
  runAssistantTurn,
  resolveAssistantAgent,
  CHATTABLE_ROLES,
  type AssistantTurnResult,
  type RunAssistantTurnOptions,
} from './run-turn';
export { stageLabelForStep, type StageLabel } from './stage-label';
export {
  pickWebDefaultAgent,
  ROLE_TIEBREAK,
  type WebDefaultCandidate,
} from './select';
export {
  runTeamTurn,
  TEAM_RESPONDER_SLUG,
  type TeamTurnResult,
  type RunTeamTurnOptions,
} from './run-team-turn';
export {
  ASSISTANT_TURN_WORKFLOW,
  TEAM_TURN_WORKFLOW,
  RUNNER_QUEUE,
  resolveSystemDatabaseUrl,
  type AssistantTurnInput,
  type AssistantTurnRunResult,
  type TeamTurnInput,
  type TeamTurnRunResult,
} from './contract';
