/**
 * GitHub Copilot token exchange.
 *
 * The Copilot chat endpoint (`api.githubcopilot.com`) authenticates with a
 * SHORT-LIVED Copilot token (`tid=…;exp=…`), not a GitHub PAT. That token is
 * minted by exchanging a GitHub OAuth token (the one the VS Code / CLI Copilot
 * flow issues, `gho_…`) at `api.github.com/copilot_internal/v2/token`. Tokens
 * last ~25 min, so we cache the exchange per OAuth token and refresh before
 * expiry. Mirrors what opencode / the Copilot CLI do (and Hermes'
 * `hermes_cli/copilot_auth.py`).
 *
 * The operator stores their GitHub OAuth token as the worker's API key. If they
 * instead paste an already-minted Copilot token (it contains `tid=`), we use it
 * verbatim — no exchange, no caching.
 */

import { ChatHttpError } from './retry';

/** Editor identity Copilot expects on every request. Kept in one place so the
 *  exchange and the chat call send a consistent fingerprint. */
export const COPILOT_EDITOR_VERSION = 'vscode/1.104.1';
const COPILOT_USER_AGENT = 'Mantle/1.0';
const TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';
/** Refresh this many ms before the reported expiry, to avoid racing a 401. */
const EXPIRY_SKEW_MS = 120_000;

/** Standard Copilot request headers (everything except Authorization). The
 *  endpoint rejects requests without the editor/integration fingerprint. */
export function copilotHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    'Editor-Version': COPILOT_EDITOR_VERSION,
    'User-Agent': COPILOT_USER_AGENT,
    'Copilot-Integration-Id': 'vscode-chat',
    'Openai-Intent': 'conversation-edits',
    'x-initiator': 'agent',
    ...(extra ?? {}),
  };
}

/** True when the supplied key is already a minted Copilot token (skip exchange). */
function isCopilotToken(key: string): boolean {
  return key.includes('tid=');
}

type CachedToken = { token: string; expiresAtMs: number };
/** Per-OAuth-token cache of the exchanged Copilot token. */
const tokenCache = new Map<string, CachedToken>();
/** In-flight exchanges, so concurrent calls share one round-trip per key. */
const inflight = new Map<string, Promise<string>>();

async function exchange(oauthToken: string): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: 'GET',
    headers: {
      Authorization: `token ${oauthToken}`,
      'Editor-Version': COPILOT_EDITOR_VERSION,
      'User-Agent': COPILOT_USER_AGENT,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ChatHttpError({ provider: 'copilot', status: res.status, body: `token exchange: ${body.slice(0, 300)}` });
  }
  const json = (await res.json()) as { token?: string; expires_at?: number };
  if (!json.token) {
    throw new ChatHttpError({ provider: 'copilot', status: 502, body: 'token exchange: response had no token' });
  }
  // expires_at is unix SECONDS; fall back to a conservative 20-min TTL.
  const expiresAtMs =
    typeof json.expires_at === 'number' ? json.expires_at * 1000 : Date.now() + 20 * 60_000;
  tokenCache.set(oauthToken, { token: json.token, expiresAtMs });
  return json.token;
}

/**
 * Resolve a usable Copilot bearer token from the worker's stored key.
 * `forceRefresh` bypasses the cache (used after a 401 to re-mint once).
 */
export async function resolveCopilotToken(key: string, forceRefresh = false): Promise<string> {
  if (!key) throw new Error('copilot-chat: apiKey (GitHub OAuth token) required');
  // Already a Copilot token — use directly.
  if (isCopilotToken(key)) return key;

  if (!forceRefresh) {
    const cached = tokenCache.get(key);
    if (cached && cached.expiresAtMs - EXPIRY_SKEW_MS > Date.now()) return cached.token;
  } else {
    tokenCache.delete(key);
  }

  // Coalesce concurrent exchanges for the same OAuth token.
  const pending = inflight.get(key);
  if (pending && !forceRefresh) return pending;
  const p = exchange(key).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
