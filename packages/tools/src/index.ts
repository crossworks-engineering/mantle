export type {
  BuiltinToolDef,
  BuiltinToolHandler,
  ToolArtifact,
  ToolHandlerContext,
  ToolHandlerResult,
  ToolForModel,
  ToolCallRecord,
  ToolPrecondition,
} from './types';

export { checkToolPreconditions, type NodeTypeLookup } from './preconditions';

export {
  registerBuiltin,
  getBuiltin,
  getBuiltinHandler,
  listBuiltins,
  getBuiltinRedactFields,
  redactArgsForLogging,
} from './registry';

export {
  validateToolArgs,
  closestMatch,
  type ValidateArgsResult,
  type ArgRepair,
  type ArgViolation,
  type UnknownKey,
} from './validate-args';

export { notFound, sanitizeToolError, type NotFoundResult } from './errors';
export { UNTRUSTED_CONTENT_TOOL_SLUGS } from './untrusted';
export {
  registerDynamicSchema,
  getDynamicSchema,
  withDelegateEnum,
  type DynamicSchemaContext,
  type DynamicSchemaPatch,
  type DynamicSchemaFn,
} from './dynamic-schema';

export { BUILTIN_TOOLS } from './builtins';
export { PAGE_TOOLS, PAGE_TOOL_SLUGS } from './builtins-pages';
export { APP_TOOLS, APP_TOOL_SLUGS, APP_DATA_TOOLS, APP_DATA_TOOL_SLUGS } from './builtins-apps';
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
export { TASK_TOOLS, TASK_TOOL_SLUGS } from './builtins-tasks';
export { TERMINAL_TOOLS, TERMINAL_TOOL_SLUGS } from './builtins-terminal';
export { CONTACT_TOOLS, CONTACT_AUTO_GRANT_SLUGS } from './builtins-contacts';
export { WORKER_DELEGATION_TOOLS } from './builtins-workers';
export { EXPORT_TOOLS } from './builtins-export';
export { TOOLSMITH_TOOLS, TOOLSMITH_TOOL_SLUGS } from './builtins-toolsmith';
export { JOURNAL_TOOLS, JOURNAL_TOOL_SLUGS, JOURNAL_AUTO_GRANT_SLUGS } from './builtins-journal';
export { LOCATION_TOOLS, LOCATION_TOOL_SLUGS } from './builtins-locations';
export { PROFILE_TOOLS, PROFILE_TOOL_SLUGS } from './builtins-profile';
export { RUN_TOOLS, BANNED_ITEM_TOOLS } from './builtins-runs';
export { seedBuiltinTools, closeToolInputSchema } from './seed';
export { resolveTool, resolveTools, dispatchTool } from './dispatch';
export { isPublicToolAllowed } from './readonly-tools';
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
  notifyPendingCreated,
  notifyPendingChanged,
  PENDING_CHANGED_CHANNEL,
} from './pending-notify';

export {
  registerAgentInvoker,
  getAgentInvoker,
  type AgentInvoker,
  type InvokeAgentInput,
  type InvokeAgentResult,
} from './agent-bridge';

export {
  MAX_AGENT_DEPTH,
  MAX_TERMINAL_EDGE_DEPTH,
  checkAgentDepth,
  checkDelegationAllowed,
  isTerminalDelegateConfig,
  type DepthCheckResult,
  type AllowlistCheckResult,
} from './invoke-agent-guards';
