/**
 * OAuth2 client-credentials tokens for integration groups (RFC 6749 §4.4).
 *
 * A group carrying `integration.oauth2` names a token endpoint and two vault
 * refs (client id, client secret). When an http tool's templates mention
 * `{{oauth:<group-slug>}}`, the dispatcher asks this module for a bearer token
 * and substitutes it exactly like a `{{secret:…}}` plaintext.
 *
 * The token is a live credential, so:
 * - it lives in THIS process's memory only: never the DB, a log or a trace;
 * - it is cached until shortly before it expires (a safety margin), keyed by
 *   everything that shapes it, so a rotated secret or a changed scope gets a
 *   fresh token instead of a stale one;
 * - one fetch runs at a time per key (single-flight): N parallel tool calls
 *   share one token request;
 * - every error that leaves here is scrubbed of the client id, the secret
 *   and the token, and only the RFC 6749 §5.2 `error` / `error_description`
 *   fields of a failed response are passed on, never the raw body.
 *
 * The token endpoint goes through safeFetch, so it meets the same egress
 * rules as every runtime api-tool call (SSRF guard on the URL and on every
 * redirect hop; credentials dropped on a cross-origin hop).
 */

import { createHash } from 'node:crypto';

import type { ToolGroupOauth2 } from '@mantle/db';
import { errorMessage } from '@mantle/std';

import { scrubSecrets } from './http-template';
import { safeFetch } from './safe-fetch';
import { assertFetchableUrl } from './ssrf-guard';

const TOKEN_TIMEOUT_MS = 15_000;
/** Lifetime assumed when the provider omits `expires_in`. */
const DEFAULT_LIFETIME_MS = 5 * 60_000;
/** Longest we hold a token, whatever the provider says. */
const MAX_LIFETIME_MS = 24 * 60 * 60_000;
/** Refresh this early: a tenth of the lifetime, capped at a minute. */
const MAX_MARGIN_MS = 60_000;
/** Longest provider error text passed on. */
const MAX_ERROR_FIELD_CHARS = 200;

type CachedToken = { token: string; expiresAt: number };

const cache = new Map<string, CachedToken>();
const inflight = new Map<string, Promise<string>>();

export type ClientCredentialsRequest = {
  ownerId: string;
  groupSlug: string;
  config: ToolGroupOauth2;
  clientId: string;
  clientSecret: string;
  /** Set after the API answered 401 with this token: drop it and fetch a new
   *  one, unless another caller already replaced it. */
  staleToken?: string;
};

/** Test seams. Production callers take the defaults. */
export type ClientCredentialsDeps = {
  guard?: (url: string) => Promise<void>;
  now?: () => number;
};

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Everything that shapes the token, hashed: the secret is in the key so a
 *  rotation misses the cache, but never held as plaintext in it. */
function cacheKey(req: ClientCredentialsRequest): string {
  const c = req.config;
  return sha256(
    [
      req.ownerId,
      req.groupSlug,
      c.tokenUrl,
      c.scope ?? '',
      c.audience ?? '',
      c.clientAuth ?? 'basic',
      req.clientId,
      req.clientSecret,
    ].join('\u0000'),
  );
}

/** Lifetime minus the safety margin, from a provider `expires_in` (seconds). */
export function tokenLifetimeMs(expiresIn: unknown): number {
  const n = typeof expiresIn === 'string' ? Number(expiresIn) : expiresIn;
  const lifetime =
    typeof n === 'number' && Number.isFinite(n) && n > 0
      ? Math.min(n * 1000, MAX_LIFETIME_MS)
      : DEFAULT_LIFETIME_MS;
  return lifetime - Math.min(MAX_MARGIN_MS, lifetime / 10);
}

/**
 * A bearer token for the group, from cache when still fresh. Throws an Error
 * whose message is safe to show (scrubbed, no response body).
 */
export async function getClientCredentialsToken(
  req: ClientCredentialsRequest,
  deps: ClientCredentialsDeps = {},
): Promise<string> {
  const now = deps.now ?? Date.now;
  const key = cacheKey(req);

  const pending = inflight.get(key);
  if (pending) return pending;

  const hit = cache.get(key);
  if (hit && hit.expiresAt > now()) {
    // A 401 retry with the token we hold: that token is dead, fetch anew.
    // A 401 retry with an OLDER token: someone already refreshed, reuse it.
    if (req.staleToken === undefined || req.staleToken !== hit.token) return hit.token;
  }
  cache.delete(key);

  const p = requestToken(req, deps)
    .then(({ token, lifetimeMs }) => {
      cache.set(key, { token, expiresAt: now() + lifetimeMs });
      return token;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}

/** Forget every cached token. Tests only. */
export function clearClientCredentialsCache(): void {
  cache.clear();
  inflight.clear();
}

async function requestToken(
  req: ClientCredentialsRequest,
  deps: ClientCredentialsDeps,
): Promise<{ token: string; lifetimeMs: number }> {
  const { config, clientId, clientSecret } = req;
  const known = new Map<string, string>([
    ['client_id', clientId],
    ['client_secret', clientSecret],
  ]);
  const scrub = (s: string) => scrubSecrets(s, known);

  const form = new URLSearchParams({ grant_type: 'client_credentials' });
  if (config.scope) form.set('scope', config.scope);
  if (config.audience) form.set('audience', config.audience);
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };
  if ((config.clientAuth ?? 'basic') === 'basic') {
    // RFC 6749 §2.3.1: each part is form-urlencoded before the Basic join.
    const pair = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`;
    headers.authorization = `Basic ${Buffer.from(pair, 'utf8').toString('base64')}`;
    known.set('client_basic', headers.authorization.slice('Basic '.length));
  } else {
    form.set('client_id', clientId);
    form.set('client_secret', clientSecret);
  }

  const where = `the token endpoint for group '${req.groupSlug}'`;
  let res: Response;
  let text: string;
  try {
    res = await safeFetch(
      config.tokenUrl,
      {
        method: 'POST',
        headers,
        body: form.toString(),
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      },
      [...known.values()],
      deps.guard ?? assertFetchableUrl,
    );
    text = await res.text();
  } catch (err) {
    // No `cause`: the original error is unscrubbed, and a cause travels with
    // the thrown error into logs and traces.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`OAuth2: could not reach ${where}: ${scrub(errorMessage(err))}`);
  }

  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    /* not JSON: handled below */
  }

  if (!res.ok) {
    const field = (k: string): string =>
      typeof body?.[k] === 'string' ? scrub(body[k]).slice(0, MAX_ERROR_FIELD_CHARS) : '';
    const code = field('error');
    const desc = field('error_description');
    const detail = [code, desc].filter(Boolean).join(': ');
    throw new Error(
      `OAuth2: ${where} answered HTTP ${res.status}${detail ? ` (${detail})` : ''}. Check the token URL, the client id and secret in the vault, and the scope`,
    );
  }

  const token = body?.access_token;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error(
      `OAuth2: ${where} answered HTTP ${res.status} without an access_token. Check that the token URL is the OAuth2 token endpoint, not a login page`,
    );
  }
  const tokenType = body?.token_type;
  if (typeof tokenType === 'string' && tokenType.toLowerCase() !== 'bearer') {
    throw new Error(
      `OAuth2: ${where} issued a '${scrub(tokenType).slice(0, 40)}' token; only bearer tokens are supported`,
    );
  }
  return { token, lifetimeMs: tokenLifetimeMs(body?.expires_in) };
}
