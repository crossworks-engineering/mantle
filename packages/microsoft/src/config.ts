/**
 * Microsoft Graph integration — OAuth config shape, scopes, and endpoints.
 *
 * The *resolution* of a concrete config (which client id / secret / tenant /
 * redirect URI to use) lives in `config-store.ts`, which prefers a UI-set
 * `microsoft_config` row and falls back to `MS_*` env. This module holds only
 * the pure pieces with no DB or env coupling, plus the env reader the store
 * uses for its fallback.
 */

export interface MsOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Azure tenant segment in the authority URL. `common` lets users from any
   *  org (and personal accounts) consent; a specific tenant id locks it down. */
  tenant: string;
  /** Absolute callback URL registered on the Azure app's "Web" platform.
   *  Must match exactly, byte-for-byte, what Azure has on file. */
  redirectUri: string;
}

/** Microsoft identity platform v2 authority. */
const AUTHORITY = 'https://login.microsoftonline.com';

/**
 * Delegated scopes the foundation asks for up front, so a single consent
 * covers every surface (SharePoint/OneDrive files, Outlook mail + calendar)
 * and users never have to re-consent as M1–M3 land. All read-only for v1 —
 * widen to `.ReadWrite` only when a write feature actually needs it.
 */
export const MS_SCOPES = [
  'offline_access',
  'openid',
  'profile',
  'Files.Read.All',
  'Sites.Read.All',
  'Mail.Read',
  'Calendars.Read',
] as const;

export function msScopeString(): string {
  return MS_SCOPES.join(' ');
}

export function authorizeEndpoint(tenant: string): string {
  return `${AUTHORITY}/${tenant}/oauth2/v2.0/authorize`;
}

export function tokenEndpoint(tenant: string): string {
  return `${AUTHORITY}/${tenant}/oauth2/v2.0/token`;
}

/** Build the canonical redirect URI for an app origin (e.g. `https://host`).
 *  The settings form prefills this; whatever is stored must match Azure. */
export function defaultRedirectUri(origin: string): string {
  return `${origin.replace(/\/$/, '')}/api/microsoft/oauth/callback`;
}

/**
 * Resolve a complete OAuth config from `MS_*` env, or null if env doesn't have
 * at least a client id + secret. Used as the fallback when no UI config row
 * exists. The redirect URI falls back to NEXT_PUBLIC_APP_URL-derived if
 * MS_REDIRECT_URI isn't set explicitly.
 */
export function oauthConfigFromEnv(): MsOAuthConfig | null {
  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const tenant = process.env.MS_TENANT || 'common';
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || '';
  const redirectUri = process.env.MS_REDIRECT_URI || (appUrl ? defaultRedirectUri(appUrl) : '');
  if (!/^https?:\/\//.test(redirectUri)) return null;
  return { clientId, clientSecret, tenant, redirectUri };
}
