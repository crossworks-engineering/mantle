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
 * Pre-registered apps (`oauth.client`): some authorization servers offer no
 * dynamic registration at all — Microsoft Entra ID, which fronts every
 * Microsoft MCP server (Power BI, Fabric), is the big one. There the owner
 * registers an app by hand and the connector uses it:
 * - `microsoft` borrows the Settings → Microsoft app (id, secret, tenant),
 *   resolved fresh on every flow. Sign-in goes to that TENANT's authority,
 *   not the `organizations` endpoint the server advertises: a single-tenant
 *   app cannot use the latter (AADSTS50194).
 * - `manual` is any other app: its registration JSON is sealed in
 *   `oauth-client` up front, so the SDK finds it and skips registration.
 * Both plug into the SDK's own provider hooks (`clientInformation`,
 * `discoveryState`, `validateResourceURL`), no fork.
 *
 * Two provider modes:
 * - START/COMPLETE (interactive): `startMcpOAuth` captures the authorization
 *   URL for the owner's browser; `completeMcpOAuth` exchanges the callback
 *   code. Driven by the connectors API routes. A failure clears the in-flight
 *   marker and records `lastError`, so the connector never sits on a silent
 *   `pending`.
 * - RUNTIME (non-interactive): the transport's authProvider. Refresh happens
 *   silently; when a re-authorization would be needed mid-call, the provider
 *   marks the connector `needs_reconnect` and throws a teaching error instead
 *   of redirecting — a tool call can't open a browser.
 */

import { randomUUID } from 'node:crypto';
import {
  auth,
  discoverOAuthProtectedResourceMetadata,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { and, eq } from 'drizzle-orm';
import {
  db,
  toolGroups,
  type ToolGroupMcpBinding,
  type ToolGroupMcpOAuth,
  type ToolGroupMcpOAuthClient,
} from '@mantle/db';
import { deleteApiKey, getApiKey, listApiKeys, setApiKey } from '@mantle/api-keys';
import { microsoftAuthority, resolveOAuthConfig } from '@mantle/microsoft';
import { errorMessage } from '@mantle/std';
import { assertFetchableUrl } from './ssrf-guard';

/** Vault labels under service = the connector's group slug. */
export const MCP_OAUTH_SECRET_LABELS = ['oauth-client', 'oauth-tokens', 'oauth-verifier'] as const;
type OAuthSecretLabel = (typeof MCP_OAUTH_SECRET_LABELS)[number];

export { isMcpManagedSecretService, MCP_VAULT_SERVICE_PREFIX } from './integration-meta';

/** The Settings → Microsoft app as a connector borrows it. */
export type MicrosoftOAuthApp = {
  clientId: string;
  clientSecret: string;
  /** Tenant authority, e.g. https://login.microsoftonline.com/<tenant>/v2.0 */
  authorizationServer: string;
};

/** Persistence seam: bookkeeping on the binding + sealed secrets. */
export type McpOAuthStore = {
  groupSlug: string;
  loadMcp(): Promise<ToolGroupMcpBinding | null>;
  saveMcp(next: ToolGroupMcpBinding): Promise<void>;
  getSecret(label: OAuthSecretLabel): Promise<string | null>;
  setSecret(label: OAuthSecretLabel, value: string): Promise<void>;
  deleteSecret(label: OAuthSecretLabel): Promise<void>;
  /** The Settings → Microsoft app, or null when none is configured. */
  microsoftApp(): Promise<MicrosoftOAuthApp | null>;
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
    microsoftApp: async () => {
      const cfg = await resolveOAuthConfig(ownerId);
      if (!cfg) return null;
      return {
        clientId: cfg.clientId,
        clientSecret: cfg.clientSecret,
        authorizationServer: microsoftAuthority(cfg.tenant),
      };
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

/**
 * The OAuth fetch, remembering the FIRST error an endpoint answers with. On
 * `invalid_client` the SDK wipes the credentials and retries by itself; during
 * a code exchange that retry dies on the (now deleted) PKCE verifier, and its
 * error buries the real reason, e.g. Entra's AADSTS700025.
 */
function recordingOAuthFetch(): { fetchFn: typeof fetch; firstError: () => string | null } {
  let first: string | null = null;
  const fetchFn: typeof fetch = async (input, init) => {
    const res = await mcpOAuthFetch(input, init);
    if (!res.ok && first === null) {
      const body = (await res
        .clone()
        .json()
        .catch(() => null)) as { error?: unknown; error_description?: unknown } | null;
      const parts = [body?.error, body?.error_description].filter(
        (v): v is string => typeof v === 'string' && v.length > 0,
      );
      if (parts.length > 0) first = parts.join(': ');
    }
    return res;
  };
  return { fetchFn, firstError: () => first };
}

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

const NO_MICROSOFT_APP =
  'this connector borrows the Microsoft app, but Settings → Microsoft has none configured. Add the app there (client id, secret, tenant) first, or switch the connector to a manual app';

/**
 * Entra touch-ups to the SDK's authorization URL. The SDK appends
 * `prompt=consent` whenever `offline_access` is asked for. On a tenant where
 * users may not consent to apps themselves, that turns an app an admin has
 * ALREADY consented into a "Need admin approval" wall. Show the account picker
 * instead, exactly like the Graph sign-in (packages/microsoft oauth.ts).
 */
function microsoftAuthorizeUrl(url: URL): URL {
  const next = new URL(url);
  next.searchParams.delete('prompt');
  next.searchParams.set('prompt', 'select_account');
  return next;
}

type ProviderOpts = {
  /** redirect_uri for this flow; undefined in runtime mode. */
  redirectUrl?: string;
  /** OAuth state parameter (start mode). */
  state?: string;
  /** Start mode: capture the authorization URL instead of failing. */
  onRedirect?: (url: URL) => void;
  /** The connector's pre-registered app, if any. */
  client?: ToolGroupMcpOAuthClient;
};

function makeProvider(store: McpOAuthStore, opts: ProviderOpts): OAuthClientProvider {
  const client = opts.client;
  const clientMetadata: OAuthClientMetadata = {
    client_name: 'Mantle',
    redirect_uris: opts.redirectUrl ? [opts.redirectUrl] : [],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  };
  // Resolved at most once per provider: the SDK asks for the client and the
  // discovery state separately within one auth() run.
  let microsoftApp: Promise<MicrosoftOAuthApp> | null = null;
  const borrowMicrosoftApp = () =>
    (microsoftApp ??= store.microsoftApp().then((app) => {
      if (!app) throw new Error(`MCP connector '${store.groupSlug}': ${NO_MICROSOFT_APP}`);
      return app;
    }));

  return {
    get redirectUrl() {
      return opts.redirectUrl;
    },
    get clientMetadata() {
      return clientMetadata;
    },
    ...(opts.state ? { state: () => opts.state! } : {}),
    clientInformation: async () => {
      if (client?.source === 'microsoft') {
        const app = await borrowMicrosoftApp();
        // client_secret_post, like packages/microsoft: Entra lists it, and it
        // spares the secret the Basic-auth encoding rules.
        return {
          client_id: app.clientId,
          client_secret: app.clientSecret,
          token_endpoint_auth_method: 'client_secret_post',
        };
      }
      return loadJsonSecret<OAuthClientInformationMixed>(store, 'oauth-client');
    },
    // Reached only by dynamic registration: a pre-registered app is always
    // returned by clientInformation() above, so the SDK never registers.
    saveClientInformation: async (info) => {
      await store.setSecret('oauth-client', JSON.stringify(info));
      await patchOAuthState(store, { clientId: String(info.client_id ?? '') });
    },
    discoveryState: async () => {
      if (client?.source === 'microsoft') {
        return { authorizationServerUrl: (await borrowMicrosoftApp()).authorizationServer };
      }
      if (client?.source === 'manual' && client.authorizationServer) {
        return { authorizationServerUrl: client.authorizationServer };
      }
      return undefined; // full RFC 9728 discovery
    },
    // Entra v2 derives the token audience from the scope; the RFC 8707
    // `resource` parameter adds nothing there but a way to fail.
    ...(client?.source === 'microsoft' ? { validateResourceURL: async () => undefined } : {}),
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
        opts.onRedirect(
          client?.source === 'microsoft'
            ? microsoftAuthorizeUrl(authorizationUrl)
            : authorizationUrl,
        );
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
      // A pre-registered app is configuration the owner typed in, not a
      // registration the server can revoke: never delete it. (The SDK
      // invalidates 'all' on invalid_client, e.g. an expired secret.)
      if ((scope === 'all' || scope === 'client') && !client) {
        await store.deleteSecret('oauth-client');
      }
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
  oauth?: Pick<ToolGroupMcpOAuth, 'redirectUri' | 'client'>,
): OAuthClientProvider {
  return makeProvider(store, {
    redirectUrl: oauth?.redirectUri ?? 'https://mantle.invalid/oauth/callback',
    client: oauth?.client,
  });
}

/** Cures for the Entra errors an owner can actually hit while connecting,
 *  appended to the raw message (which keeps its AADSTS code for searching). */
const ENTRA_HINTS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /AADSTS700025/,
    "In Azure, this connector's callback URL is registered under 'Mobile and desktop applications'. Move it to the 'Web' platform: Mantle is a server app that sends the client secret.",
  ],
  [
    /AADSTS7000215|AADSTS7000222/,
    'The client secret in Settings → Microsoft is wrong or has expired. Create a new one in Azure and save it there.',
  ],
  [
    /AADSTS65001/,
    "The Azure app has no consent for this server's API permissions. Add them in Azure (API permissions) and grant admin consent.",
  ],
  [
    /AADSTS50011/,
    "Add this connector's callback URL to the Azure app as a 'Web' redirect URI, exactly as the connectors screen shows it.",
  ],
  [
    /AADSTS50194/,
    'The Azure app is single-tenant, but sign-in went to a multi-tenant endpoint. Check the tenant in Settings → Microsoft.',
  ],
];

/** A connector OAuth error with its cure appended, when one is known. */
export function explainMcpOAuthError(message: string): string {
  const hint = ENTRA_HINTS.find(([re]) => re.test(message))?.[1];
  return hint ? `${message} (${hint})` : message;
}

const isMicrosoftAuthority = (url: string): boolean => {
  try {
    return /^login\.microsoftonline\./i.test(new URL(url).hostname);
  } catch {
    return false;
  }
};

/** Turn a failed start into something the owner can act on. The SDK's own
 *  words for a server without dynamic registration ("Incompatible auth
 *  server: …") name the problem, not the cure. */
async function teachingStartError(err: unknown, mcp: ToolGroupMcpBinding): Promise<string> {
  const msg = explainMcpOAuthError(errorMessage(err));
  if (!/does not support dynamic client registration/i.test(msg)) return msg;
  let host = mcp.url;
  try {
    host = new URL(mcp.url).host;
  } catch {
    /* keep raw */
  }
  const prm = await discoverOAuthProtectedResourceMetadata(mcp.url, {}, mcpOAuthFetch).catch(
    () => undefined,
  );
  if (prm?.authorization_servers?.some(isMicrosoftAuthority)) {
    return `${host} signs in through Microsoft Entra ID, which does not let apps register themselves. Switch this connector to the Microsoft app (it borrows the app from Settings → Microsoft), then authorize again. In Azure, that app needs this server's API permissions, and this connector's callback URL as a 'Web' redirect URI.`;
  }
  return `${host} signs in through an authorization server that does not let apps register themselves (no dynamic client registration). Register an app with that provider, switch this connector to a manual app with its client id and secret, then authorize again.`;
}

/**
 * The scope a flow asks for. An explicit binding scope wins. A Microsoft app
 * otherwise takes what the server advertises (RFC 9728 `scopes_supported`),
 * and always gets `offline_access`: without it Entra issues no refresh token
 * and the connection dies at the first access-token expiry (~1h). Anything
 * else leaves the choice to the SDK (undefined).
 */
async function authorizationScope(mcp: ToolGroupMcpBinding): Promise<string | undefined> {
  const oauth = mcp.oauth;
  let scope = oauth?.scope;
  if (oauth?.client?.source !== 'microsoft') return scope;
  if (!scope) {
    const prm = await discoverOAuthProtectedResourceMetadata(mcp.url, {}, mcpOAuthFetch).catch(
      () => undefined,
    );
    scope = prm?.scopes_supported?.join(' ');
    if (!scope) {
      throw new Error(
        `the server does not advertise which scopes to ask for (no RFC 9728 scopes_supported). Set the connector's OAuth scope by hand, e.g. "https://<resource>/.default"`,
      );
    }
  }
  const parts = scope.split(/\s+/).filter(Boolean);
  if (!parts.includes('offline_access')) parts.push('offline_access');
  return parts.join(' ');
}

export type StartMcpOAuthResult =
  { authorizeUrl: string; state: string } | { alreadyAuthorized: true };

/**
 * Begin (or re-begin) the authorization flow: record pending state on the
 * binding, run discovery + registration, and hand back the authorization URL
 * for the owner's browser. Safe to call again — it supersedes any prior
 * pending flow. On failure the pending marker is cleared and the reason is
 * recorded as `lastError` before the (teaching) error is rethrown.
 */
export async function startMcpOAuth(
  store: McpOAuthStore,
  args: { redirectUri: string },
): Promise<StartMcpOAuthResult> {
  const mcp = await store.loadMcp();
  if (!mcp) throw new Error(`'${store.groupSlug}' is not an MCP connector group`);
  const state = randomUUID();
  const prior: Partial<ToolGroupMcpOAuth> = { ...mcp.oauth };
  delete prior.lastError;
  await store.saveMcp({
    ...mcp,
    oauth: {
      ...prior,
      enabled: true,
      status: prior.status === 'connected' ? 'connected' : 'pending',
      pending: { state, redirectUri: args.redirectUri, startedAt: new Date().toISOString() },
    },
  });

  let captured: URL | null = null;
  const provider = makeProvider(store, {
    redirectUrl: args.redirectUri,
    state,
    client: mcp.oauth?.client,
    onRedirect: (url) => {
      captured = url;
    },
  });
  try {
    const scope = await authorizationScope(mcp);
    const result = await auth(provider, {
      serverUrl: mcp.url,
      fetchFn: mcpOAuthFetch,
      ...(scope ? { scope } : {}),
    });
    if (result === 'AUTHORIZED') {
      // Existing tokens still work (e.g. reconnect clicked needlessly).
      await patchOAuthState(store, { status: 'connected', pending: undefined });
      return { alreadyAuthorized: true };
    }
    if (!captured) throw new Error('authorization flow produced no redirect URL');
    return { authorizeUrl: (captured as URL).toString(), state };
  } catch (err) {
    const msg = await teachingStartError(err, mcp);
    await patchOAuthState(store, { pending: undefined, lastError: msg.slice(0, 500) });
    throw new Error(msg, { cause: err });
  }
}

/**
 * Finish the flow with the code from the callback. The caller has already
 * matched `state` to this connector. Exchanges the code (PKCE verifier from
 * the vault), seals the tokens, clears the pending marker. A failed exchange
 * clears the marker too and records why.
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
  const provider = makeProvider(store, {
    redirectUrl: mcp.oauth.pending.redirectUri,
    client: mcp.oauth.client,
  });
  const { fetchFn, firstError } = recordingOAuthFetch();
  try {
    const result = await auth(provider, {
      serverUrl: mcp.url,
      authorizationCode: args.code,
      fetchFn,
    });
    if (result !== 'AUTHORIZED') throw new Error('token exchange did not complete');
  } catch (err) {
    // The code and its verifier are single-use: this flow is over either way.
    const msg = explainMcpOAuthError(firstError() ?? errorMessage(err));
    await store.deleteSecret('oauth-verifier');
    // The SDK's retry may have wiped the tokens and marked needs_reconnect;
    // report what is actually true now.
    const hasTokens = !!(await loadMcpOAuthTokens(store));
    const prior = mcp.oauth.status;
    await patchOAuthState(store, {
      status: hasTokens ? prior : prior === 'pending' ? 'pending' : 'needs_reconnect',
      pending: undefined,
      lastError: msg.slice(0, 500),
    });
    throw new Error(msg, { cause: err });
  }
  await store.deleteSecret('oauth-verifier');
  await patchOAuthState(store, {
    status: 'connected',
    pending: undefined,
    lastError: undefined,
    connectedAt: new Date().toISOString(),
    redirectUri: mcp.oauth.pending.redirectUri,
  });
}

/**
 * End an in-flight authorization that came back without a code (the provider
 * redirected with `error=…`, e.g. consent refused): clear the marker, drop
 * the verifier, record why. Without this the connector sits on `pending`
 * with no reason, which is exactly how the first Power BI attempt looked.
 */
export async function abandonMcpOAuth(store: McpOAuthStore, reason: string): Promise<string> {
  const msg = explainMcpOAuthError(reason);
  await store.deleteSecret('oauth-verifier');
  await patchOAuthState(store, { pending: undefined, lastError: msg.slice(0, 500) });
  return msg;
}

/** How a connector gets its OAuth app — the API/tool-facing input. */
export type McpOAuthClientInput =
  | { source: 'dynamic' }
  | { source: 'microsoft' }
  | { source: 'manual'; clientId: string; clientSecret?: string; authorizationServer?: string };

function sameClient(prior: ToolGroupMcpOAuth, input: McpOAuthClientInput): boolean {
  const cur = prior.client;
  if (input.source === 'dynamic') return !cur;
  if (input.source === 'microsoft') return cur?.source === 'microsoft';
  return (
    cur?.source === 'manual' &&
    prior.clientId === input.clientId.trim() &&
    (cur.authorizationServer ?? '') === (input.authorizationServer?.trim() ?? '') &&
    !input.clientSecret
  );
}

/**
 * Point an OAuth connector at a pre-registered app, or back to dynamic
 * registration, and/or set its scope (`''` clears it). A real client change
 * drops the tokens minted for the old app (they are bound to it), so a
 * connected connector flips to `needs_reconnect`; re-sending the current
 * client is a no-op, so a form save cannot cut a live connection.
 */
export async function setMcpOAuthClient(
  store: McpOAuthStore,
  input: { client?: McpOAuthClientInput; scope?: string },
): Promise<void> {
  const mcp = await store.loadMcp();
  if (!mcp?.oauth?.enabled) {
    throw new Error(
      `'${store.groupSlug}' is not an OAuth connector — create it with OAuth enabled to choose its app`,
    );
  }
  const next: ToolGroupMcpOAuth = { ...mcp.oauth };

  const c = input.client;
  if (c && !sameClient(mcp.oauth, c)) {
    if (c.source === 'microsoft' && !(await store.microsoftApp())) {
      throw new Error(`'${store.groupSlug}': ${NO_MICROSOFT_APP}`);
    }
    if (c.source === 'manual') {
      const clientId = c.clientId.trim();
      if (!clientId) throw new Error('a manual app needs its client id');
      const authorizationServer = c.authorizationServer?.trim();
      await store.setSecret(
        'oauth-client',
        JSON.stringify({
          client_id: clientId,
          ...(c.clientSecret ? { client_secret: c.clientSecret } : {}),
        }),
      );
      next.clientId = clientId;
      next.client = authorizationServer
        ? { source: 'manual', authorizationServer }
        : { source: 'manual' };
    } else {
      // No stored registration may linger: it would short-circuit dynamic
      // registration, or shadow the borrowed Microsoft app.
      await store.deleteSecret('oauth-client');
      delete next.clientId;
      if (c.source === 'microsoft') next.client = { source: 'microsoft' };
      else delete next.client;
    }
    await store.deleteSecret('oauth-tokens');
    await store.deleteSecret('oauth-verifier');
    delete next.pending;
    delete next.lastError;
    delete next.tokenExpiresAt;
    delete next.connectedAt;
    next.status = mcp.oauth.status === 'pending' ? 'pending' : 'needs_reconnect';
  }

  if (input.scope !== undefined) {
    const scope = input.scope.trim().replace(/\s+/g, ' ');
    if (scope) next.scope = scope;
    else delete next.scope;
  }
  await store.saveMcp({ ...mcp, oauth: next });
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
