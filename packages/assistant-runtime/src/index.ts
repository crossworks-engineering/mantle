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
export {
  pickWebDefaultAgent,
  ROLE_TIEBREAK,
  type WebDefaultCandidate,
} from './select';
export {
  ASSISTANT_TURN_WORKFLOW,
  RUNNER_QUEUE,
  resolveSystemDatabaseUrl,
  type AssistantTurnInput,
} from './contract';
