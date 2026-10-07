/**
 * @mantle/assistant-runtime — full conversational-turn execution on the unified
 * per-(owner, agent) stream, one layer above @mantle/agent-runtime (which owns
 * the low-level tool loop). Sits here, not in agent-runtime, because a turn
 * needs @mantle/heartbeats + @mantle/content and heartbeats already depends on
 * agent-runtime (so agent-runtime can't depend back on it). Imported by the web
 * route today and the durable server/api runner next.
 */

export {
  runAssistantTurn,
  resolveAssistantAgent,
  setTurnSuggestionHook,
  CHATTABLE_ROLES,
  type AssistantTurnResult,
  type RunAssistantTurnOptions,
  type TurnSuggestionContext,
  type TurnSuggestionHook,
} from './run-turn';
export { stageLabelForStep, type StageLabel } from './stage-label';
export {
  assembleResponderTurn,
  base64Bytes,
  decideImageRouting,
  runWithImageFallback,
  type AssembledResponderTurn,
  type AssembleResponderTurnOptions,
  type HeartbeatSurface,
  type ResponderLoopOverrides,
} from './assemble-turn';
export {
  runResponderLoop,
  buildPersistedTrail,
  emptyLoopResult,
  EMPTY_REPLY_FALLBACK,
  type ResponderLoopResult,
  type RunResponderLoopOptions,
} from './responder-loop';
export {
  runSimulatedResponderTurn,
  type RunSimulatedResponderTurnOptions,
  type RunSimulatedResponderTurnResult,
  type SimHistoryTurn,
  type SimToolCall,
} from './run-sim-turn';
export {
  assertOwnerTurnAgent,
  describeResponderTurnInput,
  TURN_INPUT_DIFFERENCES,
  type DescribeResponderTurnInputOptions,
  type ResponderTurnInput,
  type TurnInputMessage,
  type TurnInputTool,
} from './turn-input';
export {
  recordMcpResponderTurn,
  MCP_TURN_CHANNEL,
  MCP_TURN_MAX_MESSAGE,
  MCP_TURN_MAX_REPLY,
  type RecordMcpResponderTurnOptions,
  type RecordMcpResponderTurnResult,
} from './record-mcp-turn';
export {
  describeResponderPersona,
  type DescribeResponderPersonaOptions,
  type ResponderPersonaDescription,
} from './describe-persona';
export { pickWebDefaultAgent, ROLE_TIEBREAK, type WebDefaultCandidate } from './select';
export {
  runTeamTurn,
  runClientTurn,
  TEAM_RESPONDER_SLUG,
  CLIENT_RESPONDER_SLUG,
  type TeamTurnResult,
  type RunTeamTurnOptions,
  type RunClientTurnOptions,
} from './run-team-turn';
export {
  ASSISTANT_TURN_WORKFLOW,
  TEAM_TURN_WORKFLOW,
  CLIENT_TURN_WORKFLOW,
  RETIRED_FORUM_TURN_WORKFLOW,
  RUNNER_QUEUE,
  MEMBER_TURN_QUEUE,
  CLIENT_TURN_QUEUE,
  resolveSystemDatabaseUrl,
  type AssistantTurnInput,
  type AssistantTurnRunResult,
  type TeamTurnInput,
  type TeamTurnRunResult,
  type ClientTurnInput,
} from './contract';
