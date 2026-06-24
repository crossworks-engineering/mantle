/**
 * Delegated OAuth2 — Authorization Code flow with PKCE against the Microsoft
 * identity platform (v2). This is the one piece with no prior art in Mantle:
 * every other integration uses a static secret. Tokens expire (~60–90 min) and
 * must be refreshed; that machinery lives here + in `token-store.ts`.
 *
 * Flow:
 *   1. buildAuthorizeUrl()  — UI redirects the user here to sign in + consent
 *   2. exchangeCode()       — callback swaps the code (+ PKCE verifier) for tokens
 *   3. refreshTokens()      — token-store calls this when an access token nears expiry
 */
import { createHash, randomBytes } from 'node:crypto';
import { authorizeEndpoint, getOAuthConfig, msScopeString, tokenEndpoint } from './config';

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface PkcePair {
  /** High-entropy secret kept server-side (cookie) until the code exchange. */
  verifier: string;
  /** SHA-256(verifier), sent to Azure on the authorize redirect. */
  challenge: string;
}

/** RFC 7636 PKCE pair. `S256` challenge method. */
export function createPkce(): PkcePair {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** Opaque CSRF token round-tripped through the authorize redirect and checked
 *  in the callback. */
export function createState(): string {
  return b64url(randomBytes(16));
}

/** Build the URL to send the user's browser to for sign-in + consent. */
export function buildAuthorizeUrl(opts: { state: string; challenge: string }): string {
  const cfg = getOAuthConfig();
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: 'code',
    redirect_uri: cfg.redirectUri,
    response_mode: 'query',
    scope: msScopeString(),
    state: opts.state,
    code_challenge: opts.challenge,
    code_challenge_method: 'S256',
    // Always show the account picker so a user can connect a different identity
    // than the one their browser is already signed into.
    prompt: 'select_account',
  });
  return `${authorizeEndpoint(cfg.tenant)}?${params.toString()}`;
}

export interface TokenSet {
  accessToken: string;
  /** Absolute expiry, computed from `expires_in` at receipt time. */
  expiresAt: Date;
  /** Azure rotates this on every refresh — always persist the latest. */
  refreshToken: string | null;
  /** Space-delimited scopes actually granted (may differ from requested). */
  scope: string;
}

interface RawTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type: string;
  error?: string;
  error_description?: string;
}

async function postToken(body: URLSearchParams): Promise<TokenSet> {
  const cfg = getOAuthConfig();
  const res = await fetch(tokenEndpoint(cfg.tenant), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = (await res.json().catch(() => ({}))) as RawTokenResponse;
  if (!res.ok || json.error || !json.access_token) {
    // error_description carries the actionable detail (AADSTS codes); surface it
    // but never the token request body.
    throw new Error(
      `Microsoft token endpoint ${res.status}: ${json.error ?? 'unknown'} — ${json.error_description ?? 'no detail'}`,
    );
  }
  return {
    accessToken: json.access_token,
    expiresAt: new Date(Date.now() + json.expires_in * 1000),
    refreshToken: json.refresh_token ?? null,
    scope: json.scope ?? '',
  };
}

/** Step 2: exchange the authorization code for the first token set. */
export function exchangeCode(opts: { code: string; verifier: string }): Promise<TokenSet> {
  const cfg = getOAuthConfig();
  return postToken(
    new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: 'authorization_code',
      code: opts.code,
      redirect_uri: cfg.redirectUri,
      code_verifier: opts.verifier,
      scope: msScopeString(),
    }),
  );
}

/** Step 3: trade a refresh token for a fresh access token (+ a rotated refresh
 *  token). The caller MUST persist `refreshToken` from the result — Azure
 *  invalidates the old one. */
export function refreshTokens(refreshToken: string): Promise<TokenSet> {
  const cfg = getOAuthConfig();
  return postToken(
    new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: msScopeString(),
    }),
  );
}

/** Fetch the signed-in user's identity (upn + display name) so we can label the
 *  connected account. Uses the access token directly — no token-store cycle. */
export async function fetchMe(accessToken: string): Promise<{ upn: string; displayName: string | null; tenantId: string | null }> {
  const res = await fetch('https://graph.microsoft.com/v1.0/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Graph /me failed: ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300));
  }
  const me = (await res.json()) as {
    userPrincipalName?: string;
    mail?: string;
    displayName?: string;
  };
  const upn = me.userPrincipalName || me.mail || '';
  if (!upn) throw new Error('Graph /me returned no userPrincipalName or mail');
  return { upn, displayName: me.displayName ?? null, tenantId: null };
}
