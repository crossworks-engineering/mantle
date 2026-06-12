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
export { TABLE_TOOLS, TABLE_TOOL_SLUGS } from './builtins-tables';
export { TOOL_RESULT_TOOLS, TOOL_RESULT_TOOL_SLUGS } from './builtins-tool-results';
export {
  processToolResultForModel,
  resolveResultHandling,
  DEFAULT_RESULT_HANDLING,
  cleanupToolResults,
  maybeSweep,
  TOOL_RESULT_MAX_CHUNKS,
  TOOL_RESULT_TTL_MS,
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
export { CONTACT_TOOLS, CONTACT_AUTO_GRANT_SLUGS } from './builtins-contacts';
export { TOOLSMITH_TOOLS, TOOLSMITH_TOOL_SLUGS } from './builtins-toolsmith';
export { LIFELOG_TOOLS, LIFELOG_TOOL_SLUGS, LIFELOG_AUTO_GRANT_SLUGS } from './builtins-lifelog';
export { seedBuiltinTools } from './seed';
export { resolveTool, resolveTools, dispatchTool } from './dispatch';
export { safeFetch } from './safe-fetch';
export { guardedFetch, assertFetchableUrl, isBlockedIp } from './ssrf-guard';
export {
  listToolsForOwner,
  getToolById,
  createTool,
  updateTool,
  deleteTool,
  type ToolSummary,
  type CreateToolInput,
  type UpdateToolInput,
} from './crud';
export {
  buildHttpRequest,
  collectParamNames,
  collectSecretRefs,
  refKey,
  scrubSecrets,
  templateStrings,
  type BuiltHttpRequest,
  type HttpHandler,
  type SecretRef,
} from './http-template';
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
