/**
 * OAuth 2.1 client for MCP connectors — the auth half of mcp-client.ts, built
 * on the SDK's `auth()` orchestrator (RFC 9728 discovery → RFC 8414 metadata
 * → RFC 7591 dynamic registration → PKCE authorization-code → refresh).
 *
 * Split around an injectable `McpOAuthStore` so the whole flow is testable
 * without a database: the db-backed store (`dbMcpOAuthStore`) persists
 * NON-SECRET bookkeeping on the group's `integration.mcp.oauth` and seals the
 * secret material in the api_keys vault under the connector's group slug —
 * labels `oauth-client` (registration JSON, may carry a client_secret),
 * `oauth-tokens` (access + refresh JSON), `oauth-verifier` (PKCE, deleted
 * after the exchange). Plaintext never lands on a row the UI or a model reads.
 *
 * Two provider modes:
 * - START/COMPLETE (interactive): `startMcpOAuth` captures the authorization
 *   URL for the owner's browser; `completeMcpOAuth` exchanges the callback
 *   code. Driven by the connectors API routes.
 * - RUNTIME (non-interactive): the transport's authProvider. Refresh happens
 *   silently; when a re-authorization would be needed mid-call, the provider
 *   marks the connector `needs_reconnect` and throws a teaching error instead
 *   of redirecting — a tool call can't open a browser.
 */

import { randomUUID } from 'node:crypto';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { and, eq } from 'drizzle-orm';
import { db, toolGroups, type ToolGroupMcpBinding, type ToolGroupMcpOAuth } from '@mantle/db';
import { deleteApiKey, getApiKey, listApiKeys, setApiKey } from '@mantle/api-keys';
import { assertFetchableUrl } from './ssrf-guard';

/** Vault labels under service = the connector's group slug. */
export const MCP_OAUTH_SECRET_LABELS = ['oauth-client', 'oauth-tokens', 'oauth-verifier'] as const;
type OAuthSecretLabel = (typeof MCP_OAUTH_SECRET_LABELS)[number];

export { isMcpManagedSecretService, MCP_VAULT_SERVICE_PREFIX } from './integration-meta';

/** Persistence seam: bookkeeping on the binding + sealed secrets. */
export type McpOAuthStore = {
  groupSlug: string;
  loadMcp(): Promise<ToolGroupMcpBinding | null>;
  saveMcp(next: ToolGroupMcpBinding): Promise<void>;
  getSecret(label: OAuthSecretLabel): Promise<string | null>;
  setSecret(label: OAuthSecretLabel, value: string): Promise<void>;
  deleteSecret(label: OAuthSecretLabel): Promise<void>;
};

export function dbMcpOAuthStore(ownerId: string, groupSlug: string): McpOAuthStore {
  const loadRow = async () => {
    const [row] = await db
      .select()
      .from(toolGroups)
      .where(and(eq(toolGroups.ownerId, ownerId), eq(toolGroups.slug, groupSlug)))
      .limit(1);
    return row ?? null;
  };
  return {
    groupSlug,
    loadMcp: async () => (await loadRow())?.integration?.mcp ?? null,
    saveMcp: async (next) => {
      const row = await loadRow();
      if (!row?.integration?.mcp) return; // connector deleted mid-flight — drop the write
      await db
        .update(toolGroups)
        .set({ integration: { ...row.integration, mcp: next }, updatedAt: new Date() })
        .where(eq(toolGroups.id, row.id));
    },
    getSecret: (label) => getApiKey(ownerId, groupSlug, label),
    setSecret: async (label, value) => {
      await setApiKey(ownerId, groupSlug, label, value);
    },
    deleteSecret: async (label) => {
      const rows = await listApiKeys(ownerId);
      const hit = rows.find((k) => k.service === groupSlug && k.label === label);
      if (hit) await deleteApiKey(ownerId, hit.id);
    },
  };
}

/** Delete every sealed OAuth secret for a connector (used on delete/reset). */
export async function clearMcpOAuthSecrets(store: McpOAuthStore): Promise<void> {
  for (const label of MCP_OAUTH_SECRET_LABELS) await store.deleteSecret(label);
}

/** SSRF-guarded fetch for the OAuth endpoints (discovery / register / token):
 *  the authorization server may be a different host than the MCP endpoint, so
 *  every URL is checked, and redirects are refused — token requests carry
 *  credentials that must not travel to a third host. */
export const mcpOAuthFetch: typeof fetch = async (input, init) => {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  await assertFetchableUrl(url);
  return fetch(input, { ...init, redirect: 'error' });
};

async function loadJsonSecret<T>(
  store: McpOAuthStore,
  label: OAuthSecretLabel,
): Promise<T | undefined> {
  const raw = await store.getSecret(label);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export async function loadMcpOAuthTokens(store: McpOAuthStore): Promise<OAuthTokens | undefined> {
  return loadJsonSecret<OAuthTokens>(store, 'oauth-tokens');
}

async function patchOAuthState(
  store: McpOAuthStore,
  patch: Partial<ToolGroupMcpOAuth>,
): Promise<void> {
  const mcp = await store.loadMcp();
  if (!mcp?.oauth) return;
  const next: ToolGroupMcpOAuth = { ...mcp.oauth, ...patch, enabled: true };
  // undefined values in the patch DELETE the field (clearing pending/lastError).
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete (next as Record<string, unknown>)[k];
  }
  await store.saveMcp({ ...mcp, oauth: next });
}

type ProviderOpts = {
  /** redirect_uri for this flow; undefined in runtime mode. */
  redirectUrl?: string;
  /** OAuth state parameter (start mode). */
  state?: string;
  /** Start mode: capture the authorization URL instead of failing. */
  onRedirect?: (url: URL) => void;
};

function makeProvider(store: McpOAuthStore, opts: ProviderOpts): OAuthClientProvider {
  const clientMetadata: OAuthClientMetadata = {
    client_name: 'Mantle',
    redirect_uris: opts.redirectUrl ? [opts.redirectUrl] : [],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  };
  return {
    get redirectUrl() {
      return opts.redirectUrl;
    },
    get clientMetadata() {
      return clientMetadata;
    },
    ...(opts.state ? { state: () => opts.state! } : {}),
    clientInformation: () => loadJsonSecret<OAuthClientInformationMixed>(store, 'oauth-client'),
    saveClientInformation: async (info) => {
      await store.setSecret('oauth-client', JSON.stringify(info));
      await patchOAuthState(store, { clientId: String(info.client_id ?? '') });
    },
    tokens: () => loadMcpOAuthTokens(store),
    saveTokens: async (tokens) => {
      await store.setSecret('oauth-tokens', JSON.stringify(tokens));
      await patchOAuthState(store, {
        status: 'connected',
        lastError: undefined,
        ...(typeof tokens.expires_in === 'number'
          ? { tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString() }
          : {}),
      });
    },
    redirectToAuthorization: async (authorizationUrl) => {
      if (opts.onRedirect) {
        opts.onRedirect(authorizationUrl);
        return;
      }
      // Runtime mode: a tool call cannot open a browser. Mark and teach.
      await patchOAuthState(store, {
        status: 'needs_reconnect',
        lastError: 'refresh failed; re-authorization required',
      });
      throw new Error(
        `MCP connector '${store.groupSlug}' needs the owner to re-authorize — reconnect it via POST /api/mcp-connectors/${store.groupSlug.replace(/^mcp-/, '')}/oauth/start (Settings → MCP connectors)`,
      );
    },
    saveCodeVerifier: async (verifier) => {
      await store.setSecret('oauth-verifier', verifier);
    },
    codeVerifier: async () => {
      const v = await store.getSecret('oauth-verifier');
      if (!v) {
        throw new Error(
          `no authorization in progress for '${store.groupSlug}' — start the flow again via its oauth/start route`,
        );
      }
      return v;
    },
    invalidateCredentials: async (scope) => {
      if (scope === 'all' || scope === 'tokens') {
        await store.deleteSecret('oauth-tokens');
        await patchOAuthState(store, { status: 'needs_reconnect' });
      }
      if (scope === 'all' || scope === 'client') await store.deleteSecret('oauth-client');
      if (scope === 'all' || scope === 'verifier') await store.deleteSecret('oauth-verifier');
    },
  };
}

/** The transport-facing provider for live tool calls. It must still present a
 *  redirect_uri: the SDK reads a redirect-less provider as a non-interactive
 *  (client_credentials) client and skips the refresh path entirely. The URI is
 *  never opened at runtime — a failed refresh throws the reconnect error
 *  instead of redirecting. */
export function runtimeMcpOAuthProvider(
  store: McpOAuthStore,
  redirectUri?: string,
): OAuthClientProvider {
  return makeProvider(store, {
    redirectUrl: redirectUri ?? 'https://mantle.invalid/oauth/callback',
  });
}

export type StartMcpOAuthResult =
  { authorizeUrl: string; state: string } | { alreadyAuthorized: true };

/**
 * Begin (or re-begin) the authorization flow: record pending state on the
 * binding, run discovery + registration, and hand back the authorization URL
 * for the owner's browser. Safe to call again — it supersedes any prior
 * pending flow.
 */
export async function startMcpOAuth(
  store: McpOAuthStore,
  args: { redirectUri: string },
): Promise<StartMcpOAuthResult> {
  const mcp = await store.loadMcp();
  if (!mcp) throw new Error(`'${store.groupSlug}' is not an MCP connector group`);
  const state = randomUUID();
  await store.saveMcp({
    ...mcp,
    oauth: {
      enabled: true,
      status: mcp.oauth?.status === 'connected' ? 'connected' : 'pending',
      ...(mcp.oauth?.clientId ? { clientId: mcp.oauth.clientId } : {}),
      pending: { state, redirectUri: args.redirectUri, startedAt: new Date().toISOString() },
    },
  });

  let captured: URL | null = null;
  const provider = makeProvider(store, {
    redirectUrl: args.redirectUri,
    state,
    onRedirect: (url) => {
      captured = url;
    },
  });
  const result = await auth(provider, { serverUrl: mcp.url, fetchFn: mcpOAuthFetch });
  if (result === 'AUTHORIZED') {
    // Existing tokens still work (e.g. reconnect clicked needlessly).
    await patchOAuthState(store, { status: 'connected', pending: undefined });
    return { alreadyAuthorized: true };
  }
  if (!captured) throw new Error('authorization flow produced no redirect URL');
  return { authorizeUrl: (captured as URL).toString(), state };
}

/**
 * Finish the flow with the code from the callback. The caller has already
 * matched `state` to this connector. Exchanges the code (PKCE verifier from
 * the vault), seals the tokens, clears the pending marker.
 */
export async function completeMcpOAuth(
  store: McpOAuthStore,
  args: { code: string },
): Promise<void> {
  const mcp = await store.loadMcp();
  if (!mcp?.oauth?.pending) {
    throw new Error(
      `no authorization in progress for '${store.groupSlug}' — start again via its oauth/start route`,
    );
  }
  const provider = makeProvider(store, { redirectUrl: mcp.oauth.pending.redirectUri });
  const result = await auth(provider, {
    serverUrl: mcp.url,
    authorizationCode: args.code,
    fetchFn: mcpOAuthFetch,
  });
  if (result !== 'AUTHORIZED') throw new Error('token exchange did not complete');
  await store.deleteSecret('oauth-verifier');
  await patchOAuthState(store, {
    status: 'connected',
    pending: undefined,
    lastError: undefined,
    connectedAt: new Date().toISOString(),
    redirectUri: mcp.oauth.pending.redirectUri,
  });
}

/** Locate the connector a callback belongs to by its pending `state` value. */
export async function findConnectorByOAuthState(
  ownerId: string,
  state: string,
): Promise<string | null> {
  if (!state) return null;
  const rows = await db.select().from(toolGroups).where(eq(toolGroups.ownerId, ownerId));
  const hit = rows.find((g) => g.integration?.mcp?.oauth?.pending?.state === state);
  return hit?.slug ?? null;
}
