export { MANTLE_MCP_INSTRUCTIONS, buildMantleMcpServer, registerMantleTools } from './build-server';
export {
  NOT_ON_WORKSPACES_ERROR,
  NO_WORKSPACE_ERROR,
  mcpAdminView,
  mcpScopeEntry,
} from './mcp-scope';
export {
  ADMIN_KIND_CREATE_ERROR,
  ADMIN_KIND_CREATE_TOOL_SLUGS,
  MCP_CREATE_TOOL_SLUGS,
  NO_WORKSPACE_CREATE_ERROR,
  WORKSPACE_ARG,
  replyItemIds,
  withLanding,
  withWorkspaceArg,
} from './create-home';
export {
  registerGatedTool,
  type McpGate,
  type McpToolEntry,
  type ToolCallGuard,
  type ToolCallResult,
} from './gated-tools';
export {
  MCP_HANDWRITTEN_READ_ONLY,
  MCP_NO_WORKSPACE_INSTRUCTIONS,
  MCP_WORKSPACE_INSTRUCTIONS,
  NOT_ON_WORKSPACES_REFUSED,
  OWNER_KEY_SPENDING_TOOLS,
  PEER_RISKY_TOOL_PREFIXES,
  PEER_RISKY_TOOL_SLUGS,
  isMcpToolReadOnly,
  isPeerRiskyTool,
  mcpInstructionsFor,
  ownerPeerAllows,
  prepareCallerTools,
  preparedKeysOff,
  preparedLists,
  registerPreparedTools,
  spendsOwnerKeys,
  type McpCaller,
  type McpLoginRole,
  type PreparedCallerTools,
} from './login-surface';
export {
  KEY_AREA_ERROR,
  OWNER_KEYS_ERROR,
  RISKY_TOOL_ERROR,
  defaultMcpGate,
  mcpCreateHomeRule,
  mcpGateCaller,
  mcpToolPolicy,
  runMcpCall,
} from './gate-policy';
export { MCP_TOOL_DEFS, mcpDefinition, type McpToolDef, type McpToolGroup } from './mcp-defs';
export {
  KEY_SHARED_CONTENT_TOOLS,
  keyAreasAllowTool,
  mcpToolPolicyOf,
  toolKeyArea,
} from './mcp-policy';
/** Boot readiness of the one gate, for the stdio MCP server (it loads
 *  @mantle/tools through this package). */
export { ensureGateReady } from '@mantle/tools';
