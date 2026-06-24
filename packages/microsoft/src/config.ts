/**
 * Microsoft Graph integration — shared, per-deployment configuration.
 *
 * Delegated (per-user) OAuth against ONE Azure app registration whose
 * credentials live in env (not per user). Self-hosted per-brain: each brain
 * carries its own `MS_CLIENT_ID`/`MS_CLIENT_SECRET` and stores per-user tokens
 * in its own Postgres. See docs/microsoft-graph-ingest.md.
 *
 * Nothing here is secret to *read* except the client secret; the values are
 * resolved lazily so a brain with no Microsoft integration configured never
 * trips on missing env until someone actually tries to connect.
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
 *
 *   offline_access  → refresh tokens (without this, no background sync)
 *   openid profile  → identify the signed-in user (upn / display name)
 *   Files.Read.All  → OneDrive + SharePoint document libraries (drives)
 *   Sites.Read.All  → SharePoint site/drive enumeration
 *   Mail.Read       → Outlook mail (M2)
 *   Calendars.Read  → Outlook calendar (M3)
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

/** True when this brain has Microsoft integration configured. Lets the UI
 *  hide the "Connect Microsoft" affordance instead of dead-ending on a 500. */
export function isMicrosoftConfigured(): boolean {
  return Boolean(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET);
}

/** Resolve the OAuth config, throwing a clear error if a brain tried to use
 *  the integration without configuring it. Callers should gate on
 *  `isMicrosoftConfigured()` first for a friendly message. */
export function getOAuthConfig(): MsOAuthConfig {
  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      'Microsoft integration is not configured — set MS_CLIENT_ID and MS_CLIENT_SECRET ' +
        '(see docs/microsoft-graph-ingest.md).',
    );
  }
  const tenant = process.env.MS_TENANT || 'common';
  // The redirect URI must be absolute and stable (Azure matches it exactly).
  // Derive it from the app's public origin unless explicitly overridden.
  const redirectUri =
    process.env.MS_REDIRECT_URI ||
    `${(process.env.NEXT_PUBLIC_APP_URL || '').replace(/\/$/, '')}/api/microsoft/oauth/callback`;
  if (!/^https?:\/\//.test(redirectUri)) {
    throw new Error(
      'Cannot derive the Microsoft OAuth redirect URI — set NEXT_PUBLIC_APP_URL ' +
        '(or MS_REDIRECT_URI) to an absolute https URL.',
    );
  }
  return { clientId, clientSecret, tenant, redirectUri };
}

export function authorizeEndpoint(tenant: string): string {
  return `${AUTHORITY}/${tenant}/oauth2/v2.0/authorize`;
}

export function tokenEndpoint(tenant: string): string {
  return `${AUTHORITY}/${tenant}/oauth2/v2.0/token`;
}
