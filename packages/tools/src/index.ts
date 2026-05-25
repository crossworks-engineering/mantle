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
export { PAGE_TOOLS, PAGE_TOOL_SLUGS } from './builtins-pages';
export { TOOL_RESULT_TOOLS, TOOL_RESULT_TOOL_SLUGS } from './builtins-tool-results';
export {
  processToolResultForModel,
  resolveResultHandling,
  DEFAULT_RESULT_HANDLING,
  cleanupToolResults,
  chunkText,
  buildResultEnvelope,
  spillToolResult,
  readResultPage,
  grepResult,
  queryResult,
  type ResultHandling,
  type ResultHandlingConfig,
} from './tool-results';
export { PERSONA_TOOLS, PERSONA_TOOL_SLUGS } from './builtins-persona';
export { TODO_TOOLS, TODO_TOOL_SLUGS } from './builtins-todos';
export { TERMINAL_TOOLS, TERMINAL_TOOL_SLUGS } from './builtins-terminal';
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
