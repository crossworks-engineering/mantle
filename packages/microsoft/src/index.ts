/**
 * @mantle/microsoft — Microsoft Graph foundation.
 *
 * M0 (this milestone): delegated OAuth2 (Auth Code + PKCE), sealed self-
 * refreshing token store, and a throttling-aware Graph client. SharePoint /
 * OneDrive (M1), Outlook mail (M2), and calendar (M3) are thin surface modules
 * built on top. See docs/microsoft-graph-ingest.md.
 */
export {
  MS_SCOPES,
  msScopeString,
  defaultRedirectUri,
  oauthConfigFromEnv,
  type MsOAuthConfig,
} from './config';
export {
  resolveOAuthConfig,
  getConfigStatus,
  isMicrosoftConfigured,
  saveConfig,
  clearConfig,
  type MsConfigStatus,
  type SaveConfigInput,
} from './config-store';
export {
  buildAuthorizeUrl,
  createPkce,
  createState,
  exchangeCode,
  refreshTokens,
  fetchMe,
  type PkcePair,
  type TokenSet,
} from './oauth';
export {
  upsertAccountFromTokens,
  getValidAccessToken,
  deleteAccount,
} from './token-store';
export { graphGet, graphGetAll, graphFetchRaw, type GraphError } from './client';
