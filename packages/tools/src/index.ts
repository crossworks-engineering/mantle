export type {
  BuiltinToolDef,
  BuiltinToolHandler,
  ToolArtifact,
  ToolHandlerContext,
  ToolHandlerResult,
  ToolForModel,
  ToolCallRecord,
} from './types';

export {
  registerBuiltin,
  getBuiltin,
  getBuiltinHandler,
  listBuiltins,
  getBuiltinRedactFields,
  redactArgsForLogging,
} from './registry';

export { BUILTIN_TOOLS } from './builtins';
export { PERSONA_TOOLS, PERSONA_TOOL_SLUGS } from './builtins-persona';
export { seedBuiltinTools } from './seed';
export { resolveTool, resolveTools, dispatchTool } from './dispatch';
export {
  listPendingCalls,
  countPending,
  getPendingCall,
  approvePendingCall,
  rejectPendingCall,
  type PendingSummary,
  type ListPendingOptions,
} from './pending';

export {
  registerAgentInvoker,
  getAgentInvoker,
  type AgentInvoker,
  type InvokeAgentInput,
  type InvokeAgentResult,
} from './agent-bridge';

export {
  MAX_AGENT_DEPTH,
  checkAgentDepth,
  checkDelegationAllowed,
  type DepthCheckResult,
  type AllowlistCheckResult,
} from './invoke-agent-guards';
