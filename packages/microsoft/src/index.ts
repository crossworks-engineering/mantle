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

// ── M1: SharePoint / OneDrive drive sync ───────────────────────────────────
export { discoverDrives } from './drives/discover';
export { syncDrive, type DriveSyncResult } from './drives/sync';
export { storeRemoteFileAsNode, type StoredFile } from './drives/store';
export { discoverForAccount, setDriveEnabled, listDrives, browseDrive, type DriveChild } from './drives/manage';
export { listScopes, setDriveScopes, ownedDrive, inScope, itemPathAfterRoot, type ScopeInput } from './drives/scope';
export { listAccounts, redactMsAccount, type PublicMsAccount } from './accounts';
// Re-export the row types the settings page renders, so it doesn't reach into
// @mantle/db directly.
export type { MsAccount, MsDrive, MsDriveScope } from '@mantle/db';
export type { DriveItem, GraphDrive, GraphSite } from './drives/types';

// ── M2: Outlook mail (reuses the email pipeline via a Graph provider) ───────
export { graphMailProvider } from './outlook/mail';
export { ensureMailAccount, setMailEnabled, getMailAccount } from './outlook/manage';
