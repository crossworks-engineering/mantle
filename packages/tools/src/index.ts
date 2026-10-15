export type {
  BuiltinToolDef,
  BuiltinToolHandler,
  ToolArtifact,
  ToolModelImage,
  ToolHandlerContext,
  ToolHandlerResult,
  ToolForModel,
  ToolCallRecord,
  ToolPrecondition,
} from './types';

export { checkToolPreconditions, type NodeTypeLookup } from './preconditions';

export {
  PolicyTableNotLoadedError,
  builtinPolicy,
  namedToolPolicy,
  policyAdminOnly,
  policyArea,
  policyLowers,
  policyMayLower,
  policyRecipeForbidden,
  policyRunItemBanned,
  policySystemWhole,
  policyUntrusted,
  toGatePolicy,
  type SurfaceToolDef,
  type ToolItemResolver,
  type ToolItemTarget,
  type ToolOutside,
  type ToolPolicy,
  type ToolScope,
} from './tool-policy';

export { MCP_SURFACE_POLICIES, type McpSurfaceSlug } from './mcp-surface-policies';

export {
  registerBuiltin,
  getBuiltin,
  getBuiltinHandler,
  listBuiltins,
  listSeedableBuiltins,
  getBuiltinRedactFields,
  isBuiltinReadOnly,
  isBuiltinSpending,
  isBuiltinOwnerOnly,
  listReadOnlyBuiltinSlugs,
  redactArgsForLogging,
  builtinRowSlugError,
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
export { buildAndStageApp, type AppBuildOutcome } from './app-build-stage';
export { importAppPackage, type AppPackageImportResult } from './app-package-import';
export { PRIVATE_OUTPUT_TOOL_SLUGS } from './private-output';
export {
  registerDynamicSchema,
  getDynamicSchema,
  withDelegateEnum,
  type DynamicSchemaContext,
  type DynamicSchemaPatch,
  type DynamicSchemaFn,
} from './dynamic-schema';
export {
  buildDeferredToolset,
  toolSourceOf,
  unwrapUseTool,
  isAlwaysFull,
  CORE_TOOL_SLUGS,
  TOOL_SEARCH_SLUG,
  USE_TOOL_SLUG,
  TOOL_SEARCH_LIMIT,
  type DeferredToolDef,
  type DeferredToolset,
  type ToolSearchResult,
  type ToolSource,
} from './selection/deferred';
export { type GroupSource as ToolGroupSource } from './selection/rank';
export { knownFlowForGroup } from './selection/flows';
export {
  renderDelegateRoster,
  buildDelegateRoster,
  ROSTER_GROUP_STOPLIST,
  ROSTER_GROUP_CLIP,
  ROSTER_LINE_MAX,
  ROSTER_TOTAL_MAX,
  type RosterDelegate,
  type RosterGroup,
} from './delegate-roster';

export {
  BUILTIN_TOOLS,
  FILE_MANAGE_TOOLS,
  NODE_READ_TOOLS,
  FILE_CREATE_TOOLS,
  CONTENT_CURATION_TOOLS,
  INGEST_TOOLS,
  SECRET_TOOLS,
  DELEGATION_TOOLS,
  SEARCH_TOOLS,
  ENTITY_TOOLS,
  FILE_TOOLS,
  TELEGRAM_TOOLS,
  TELEGRAM_OPERATOR_TOOLS,
  PENDING_TOOLS,
  WORKER_GROUP_TOOLS,
  FILE_OPERATOR_TOOLS,
} from './builtins';
export { PAGE_TOOLS, PAGE_TOOL_SLUGS } from './builtins-pages';
export { DRAW_TOOLS, DRAW_TOOL_SLUGS } from './builtins-draws';
export { APP_TOOLS, APP_TOOL_SLUGS, APP_DATA_TOOLS, APP_DATA_TOOL_SLUGS } from './builtins-apps';
export { APP_GUIDE_TOOLS } from './builtins-app-guide';
export { WORKSPACE_TOOLS, type WorkspaceListRow } from './builtins-workspaces';
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
export { NOTE_TOOLS, NOTE_OPERATOR_TOOLS } from './builtins-notes';
export { TREE_TOOLS, TREE_OPERATOR_TOOLS, TREE_TOOL_KINDS } from './builtins-tree';
export { RECALL_TOOLS } from './builtins-recall';
export { RECALL_WRITE_TOOLS } from './builtins-recall-write';
export { RECALL_OWNER_TOOLS } from './builtins-recall-owner';
export { EVENT_TOOLS } from './builtins-events';
export { PEER_TOOLS } from './builtins-peers';
export { EMAIL_TOOLS } from './builtins-email';
export { TERMINAL_TOOLS, TERMINAL_TOOL_SLUGS } from './builtins-terminal';
export { SANDBOX_TOOLS, SANDBOX_TOOL_SLUGS } from './builtins-sandbox';
export { CONTACT_TOOLS, CONTACT_AUTO_GRANT_SLUGS } from './builtins-contacts';
export { WORKER_DELEGATION_TOOLS, buildSummarizeTextInput } from './builtins-workers';
export { EXPORT_TOOLS } from './builtins-export';
export { ACCESS_TOOLS } from './builtins-access';
export { SHEET_TOOLS, SHEET_TOOL_SLUGS } from './builtins-sheets';
export { TOOLSMITH_TOOLS, TOOLSMITH_TOOL_SLUGS } from './builtins-toolsmith';
export { JOURNAL_TOOLS, JOURNAL_TOOL_SLUGS, JOURNAL_AUTO_GRANT_SLUGS } from './builtins-journal';
export { FORMULA_TOOLS, FORMULA_TOOL_SLUGS, FORMULA_AUTO_GRANT_SLUGS } from './builtins-formulas';
export { CALCULATE_TOOLS, CALCULATE_TOOL_SLUGS } from './builtins-calculate';
export { LOCATION_TOOLS, LOCATION_TOOL_SLUGS } from './builtins-locations';
export { PROFILE_TOOLS, PROFILE_TOOL_SLUGS } from './builtins-profile';
export { RUN_TOOLS, parsePlan } from './builtins-runs';
export { loadAgentGrant, NO_AGENT_RUN_SLUG, type AgentGrant } from './agent-grants';
export { REPLAY_TOOLS } from './builtins-replay';
export { IMAGE_TOOLS } from './builtins-images';
export { LOGIN_APP_DATA_TOOLS } from './builtins-app-data';
export { RESEARCH_TOOLS, resolveOpenRouterKey } from './builtins-research';
export { CURATION_TOOLS } from './builtins-curation';
export { CRAWL_TOOLS } from './builtins-crawl';
export { VIDEO_TOOLS } from './builtins-video';
export { SHARE_TOOLS } from './builtins-share';
export { EVAL_TOOLS } from './builtins-eval';
// Re-exported so MCP/route layers can pin their input caps to the SAME
// contract the plan parser validates against (they already depend on us).
export { ASK_HUMAN_FORM_LIMITS } from '@mantle/client-types';
export { seedBuiltinTools, closeToolInputSchema } from './seed';
export {
  resolveTool,
  resolveTools,
  dispatchTool,
  connectorMarkRefusal,
  APP_CALLER_SURFACE_ERROR,
  NO_TOOL_CALLER_ERROR,
  ADMIN_ONLY_ERROR,
} from './dispatch';
export {
  adminAreaError,
  areaSystem,
  callerHasArea,
  isAdminGateRefusal,
  runGated,
  type AdminGateView,
} from './admin-gate';
export { builtinItems, toolItemWriteRefusal, type ToolItems } from './item-write-gate';
export {
  SECRET_REFS_MAKER_NO_KEYS,
  SECRET_REFS_NEED_KEYS,
  handlerCarriesSecretRefs,
  secretRefsRunRefusal,
  secretRefsWriteRefusal,
  toolMaker,
  inheritedToolMaker,
  VAULT_PAIR_MAKER_NO_KEYS,
  VAULT_PAIR_NEEDS_KEYS,
  integrationPairing,
  mcpPairing,
  templateVaultRefs,
  vaultPairCallerRefusal,
  vaultPairingChanged,
  vaultPairLoginRefusal,
  vaultPairRunRefusal,
  type VaultPairing,
} from './secret-ref-gate';
export {
  makerChangeSet,
  restampHeartbeatMakers,
  type HeartbeatPromptSource,
} from './heartbeat-maker';
export {
  memberAppToolVerdict,
  memberAppRefusedName,
  type MemberAppToolVerdict,
} from './member-app-tools';
export {
  GATE_NARROWERS,
  KEY_AREA_ERROR,
  OWNER_KEYS_ERROR,
  RISKY_TOOL_ERROR,
  TEAM_APP_NO_TOOL_ERROR,
  ensureGateReady,
  registerGateNarrowers,
} from './gate-narrowers';
export {
  apiV1Caller,
  appBrokerCaller,
  currentToolCaller,
  mcpToolCaller,
  mcpVia,
  nestedToolCaller,
  ownerWebCaller,
  pendingCaller,
  runCaller,
  turnCaller,
  type ToolCaller,
  type ToolCallerEntry,
} from './gate-callers';
export { builtinToolGatePolicy, builtinToolRef, mcpBuiltinToolRef } from './tool-gate-policy';
export { turnCallRefusal, turnListedTools } from './turn-listing';
export { CONNECTOR_ELEVATED_REASON, type ElevatedApproval } from './connector-scope';
export { registerPreRunChecks } from './gate-prerun';
export { MODERATOR_SEAT_CHANGED, moderatorSeatLost } from './moderator-seat';
export { contentToolTarget, keySharedContentRefusal, type KeyOrPeer } from './key-shared-content';
export { othersCanRead } from './shared-item';
export { maskToolDatabaseErrors, thrownToolDatabaseError } from './tool-error-mask';
export {
  NO_RUNTIME_POLICY_ERROR,
  apiToolPolicy,
  appToolPolicy,
  connectorToolPolicy,
  memberAppRefusal,
  peerToolPolicy,
  recipeToolPolicy,
  runtimeToolPolicy,
  sandboxMcpToolPolicy,
  shellToolPolicy,
  type ConnectorToolPolicy,
  type RuntimeRowType,
  type RuntimeToolPolicy,
} from './runtime-policy';
export {
  setToolExternalAccess,
  externalToolVerdict,
  outsideToolVerdict,
  connectorToolVerdict,
  connectorGroupOf,
  connectorMarkState,
  VOIDED_MARK_SIG,
  listLoginConnectorTools,
  connectorOpensBeyondAdmin,
  appConnectorRefused,
  LINK_NO_CONNECTORS,
  outsideCallLogDetail,
  OUTSIDE_WRITE_LOG_INPUT_MAX,
  type OutsideToolVerdict,
  contactAppToolVerdict,
  loginConnectorRefused,
  loginConnectorRule,
  type LoginConnectorRule,
  clearConnectorExternalAccess,
  connectorMarkCount,
  voidConnectorMarksForKey,
  externalAccessActive,
  externalAccessHandlerSig,
  externalAccessToolSig,
  externalAccessIneligible,
  externalAccessSummary,
  EXTERNAL_ACCESS_KINDS,
  type SetExternalAccessResult,
  type ExternalAccessActor,
  type ExternalAccessOffActor,
} from './external-access';
export {
  appToolLevel,
  appToolRefusal,
  appToolScope,
  appToolVerdict,
  appToolWarnings,
  movedAppToolWarnings,
  APP_NO_TOOLS,
  type AppCallRules,
  type AppToolLevel,
  type AppToolRunner,
  type AppToolVerdict,
} from './app-tool-level';
export { surfaceHiddenNodeTypes, HIDDEN_NODE_ERROR } from './team-visibility';
export {
  isOwnerSurface,
  ownerKeysOff,
  ownerSurfaceLoginId,
  OWNER_ONLY_ERROR,
  type ToolSurface,
} from './surface';
export { outcomeIsThirdParty } from './third-party';
export type { LoginMcpChannel, OwnerSurfaceVia } from './types';
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
  applyInputDefaults,
  buildHttpRequest,
  collectOauthRefs,
  collectParamNames,
  collectSecretRefs,
  oauthKey,
  refKey,
  scrubSecrets,
  templateStrings,
  type BuiltHttpRequest,
  type HttpHandler,
  type SecretRef,
} from './http-template';
export {
  API_DOCS_FOLDER_PATH,
  API_DOCS_FOLDER_SLUG,
  API_DOCS_MAX_CHARS,
  apiDocsHeader,
  apiSkillSlugForGroup,
  applyIntegrationInheritance,
  describeInheritance,
  getGroupIntegration,
  joinBaseUrl,
  parseIntegrationMeta,
  readApiDocsFile,
  setGroupIntegration,
  upsertApiDocsFile,
  type IntegrationGroup,
  type InheritanceInput,
  type InheritanceResult,
  type InheritedPieces,
  type ParsedIntegration,
  type ToolGroupIntegration,
} from './integration';
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
  ApprovalRefusedError,
  ELEVATED_APPROVER_ERROR,
  ELEVATED_NO_APPROVER_ERROR,
  ELEVATED_NO_ASKER_ERROR,
  ELEVATED_NO_TOOL_ERROR,
  ELEVATED_SELF_APPROVAL_ERROR,
} from './pending-approval';
export {
  pendingOriginNow,
  PENDING_RECHECK_ERROR,
  PENDING_SCOPE_LOST_ERROR,
} from './pending-origin';

export {
  notifyPendingCreated,
  notifyPendingChanged,
  resolveApprovalChat,
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

export { KNOWN_MCP_SERVERS, knownMcpServer, type KnownMcpServer } from './mcp-catalog';
export {
  closeMcpClient,
  MCP_CALL_TIMEOUT_MS,
  mcpCallRemoteTool,
  mcpListRemoteTools,
  type McpCallOutcome,
  type McpRemoteTool,
} from './mcp-client';
export {
  createMcpConnector,
  deleteMcpConnector,
  MCP_GROUP_PREFIX,
  mcpGroupDescription,
  mcpGroupSlug,
  mcpToolSlug,
  planMcpSync,
  syncMcpConnector,
  type CreateMcpConnectorInput,
  type CreateMcpConnectorResult,
  type McpSyncPlan,
  type McpSyncResult,
  type McpSyncRowState,
} from './mcp-sync';
export { parseMcpBinding, type ToolGroupMcpBinding } from './integration-meta';
export {
  clearMcpOAuthSecrets,
  completeMcpOAuth,
  oauthAccountHash,
  type McpOAuthAccountChange,
  dbMcpOAuthStore,
  findConnectorByOAuthState,
  loadMcpOAuthTokens,
  MCP_OAUTH_SECRET_LABELS,
  runtimeMcpOAuthProvider,
  startMcpOAuth,
  setMcpOAuthClient,
  explainMcpOAuthError,
  abandonMcpOAuth,
  type McpOAuthStore,
  type McpOAuthClientInput,
  type MicrosoftOAuthApp,
  type StartMcpOAuthResult,
} from './mcp-oauth';
export { isMcpManagedSecretService, MCP_VAULT_SERVICE_PREFIX } from './integration-meta';

export { KNOWN_OPENAPI_APIS, knownOpenapiApi, type KnownOpenapiApi } from './openapi-catalog';
export {
  compileOperations,
  extractInventory,
  OPENAPI_SPEC_MAX_BYTES,
  OPENAPI_TOOL_HARD_CAP,
  OPENAPI_TOOL_WARN_THRESHOLD,
  operationKeyOf,
  operationSelected,
  parseOpenapiDocument,
  stripSecretRefs,
  type CompiledOperation,
  type CompileResult,
  type OpenapiSelection,
  type SpecInventory,
} from './openapi-spec';
export {
  createOpenapiConnector,
  deleteOpenapiConnector,
  fetchSpecText,
  isOpenapiMirrorHandler,
  OPENAPI_GROUP_PREFIX,
  openapiGroupDescription,
  openapiGroupSlug,
  openapiToolSlug,
  planOpenapiSync,
  previewOpenapiSpec,
  syncOpenapiConnector,
  type CreateOpenapiConnectorInput,
  type CreateOpenapiConnectorResult,
  type OpenapiMirrorHandler,
  type OpenapiPreview,
  type OpenapiSyncPlan,
  type OpenapiSyncResult,
  type OpenapiSyncRowState,
} from './openapi-sync';
export { parseOpenapiBinding, type ToolGroupOpenapiBinding } from './integration-meta';
export { parseOauth2Binding, type ToolGroupOauth2 } from './integration-meta';
export { reconcileMeta, ruleReconcilerFor } from './rule-reconciler';
export {
  newTurnTaint,
  taintFromText,
  uuidsIn,
  namesClientSourced,
  type TurnTaint,
} from './client-sourced';
