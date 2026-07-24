/**
 * Thin re-export so existing imports (`@/lib/api-keys`) keep working. The
 * implementation lives in `@mantle/api-keys` so apps/agent and the MCP server
 * can use the same helpers.
 */
export {
  listApiKeys,
  getApiKey,
  setApiKey,
  rotateApiKey,
  deleteApiKey,
  type ApiKeySummary,
} from '@mantle/api-keys';
