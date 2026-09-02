/**
 * Client manager for EXTERNAL MCP servers (connector groups). The hardened
 * sibling of the dev-console stdio bridge (server/web/lib/dev-tools/
 * mcp-bridge.ts): same lazy-singleton + idle-teardown + respawn-once
 * lifecycle, but streamable-HTTP only, per-(owner, connector) cached, with
 * SSRF guarding on every request and the credential resolved from the
 * api_keys vault at connect time — plaintext never lands in a row or a log.
 *
 * Threat model: the remote server is UNTRUSTED. Its tool results are flagged
 * `untrusted` by the dispatcher; here we only ensure (a) requests can't be
 * steered at internal addresses (assertFetchableUrl on every fetch, redirects
 * refused), and (b) the resolved credential is scrubbed from anything that
 * could travel back toward the model (dispatch scrubs with the same secret
 * map).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ToolGroupMcpBinding } from '@mantle/db';
import { getApiKey } from '@mantle/api-keys';
import { assertFetchableUrl } from './ssrf-guard';
import { scrubSecrets } from './http-template';
import { dbMcpOAuthStore, loadMcpOAuthTokens, runtimeMcpOAuthProvider } from './mcp-oauth';
import { errorMessage } from '@mantle/std';

const IDLE_SHUTDOWN_MS = 5 * 60 * 1000;
/** Matches web_fetch's budget — an MCP call is the same class of egress. */
export const MCP_CALL_TIMEOUT_MS = 25_000;
/** listTools on connect is cheap; keep a tighter lid on handshakes. */
const CONNECT_TIMEOUT_MS = 15_000;

export type McpRemoteTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type McpCallOutcome = {
  isError: boolean;
  /** Concatenated text content parts. */
  text: string;
  /** The server's structured result, when it sent one. */
  structured?: unknown;
};

type Entry = {
  client: Promise<Client>;
  /** Config the cached client was built from — a change forces a respawn. */
  fingerprint: string;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** The plaintext(s) resolved for this connection, for the dispatcher's scrub. */
  secrets: Map<string, string>;
};

const g = globalThis as typeof globalThis & { __mantleMcpClients?: Map<string, Entry> };
const cache: Map<string, Entry> = (g.__mantleMcpClients ??= new Map());

function fingerprintOf(mcp: ToolGroupMcpBinding): string {
  return JSON.stringify([
    mcp.url,
    mcp.secretRef ?? '',
    mcp.authHeader ?? '',
    mcp.authScheme ?? '',
    mcp.oauth?.enabled ? 'oauth' : '',
  ]);
}

/** Store factory for the OAuth runtime provider — swappable so the client can
 *  be tested against an in-memory store. Production leaves the default. */
let oauthStoreFactory: typeof dbMcpOAuthStore = dbMcpOAuthStore;
export function setMcpOAuthStoreFactoryForTests(f: typeof dbMcpOAuthStore): void {
  oauthStoreFactory = f;
}

/** Time-to-HEADERS bound on the standalone GET notification stream. The
 *  stream itself may (and should) stay open forever — only the headers must
 *  arrive promptly. Found in the wild: DeepWiki accepts the GET socket and
 *  never answers, and the hung request wedges subsequent POSTs queued on the
 *  same origin — every tool call then times out. The stream is OPTIONAL per
 *  the MCP spec, so timing it out degrades to "server doesn't push", which
 *  is exactly right. */
const SSE_GET_HEADERS_TIMEOUT_MS = 5_000;

/** SSRF-guarded fetch: every request URL is re-checked (the transport may
 *  follow the server's session redirects/resumption URLs) and redirects are
 *  refused outright — an external MCP endpoint has no business redirecting,
 *  and following one could carry the auth header to an attacker's host. */
const guardedFetch: typeof fetch = async (input, init) => {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  await assertFetchableUrl(url);

  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const accept =
    new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get(
      'accept',
    ) ?? '';
  const isSseGet = method === 'GET' && accept.includes('text/event-stream');
  if (!isSseGet) return fetch(input, { ...init, redirect: 'error' });

  // Headers-only timeout: abort while waiting for headers, never after — the
  // timer is cleared the moment the response resolves, so a healthy SSE
  // stream lives indefinitely. The transport's own signal still cancels the
  // stream via the forwarding listener.
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new Error('SSE stream headers not received in time')),
    SSE_GET_HEADERS_TIMEOUT_MS,
  );
  const upstream = init?.signal;
  if (upstream?.aborted) ctrl.abort(upstream.reason);
  else upstream?.addEventListener('abort', () => ctrl.abort(upstream.reason), { once: true });
  try {
    return await fetch(input, { ...init, redirect: 'error', signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
};

async function resolveAuth(
  ownerId: string,
  mcp: ToolGroupMcpBinding,
): Promise<{ headers: Record<string, string>; secrets: Map<string, string> }> {
  const headers: Record<string, string> = {};
  const secrets = new Map<string, string>();
  if (mcp.secretRef) {
    const [service, label] = mcp.secretRef.split('/');
    const plaintext = await getApiKey(ownerId, service!, label!);
    if (plaintext === null) {
      throw new Error(
        `secret '${mcp.secretRef}' not found in the API-key vault — add it under Settings → API keys (service '${service}', label '${label}')`,
      );
    }
    secrets.set(mcp.secretRef, plaintext);
    const scheme = mcp.authScheme ?? 'Bearer ';
    headers[mcp.authHeader ?? 'Authorization'] = `${scheme}${plaintext}`;
  }
  return { headers, secrets };
}

async function spawn(ownerId: string, groupSlug: string, mcp: ToolGroupMcpBinding): Promise<Entry> {
  await assertFetchableUrl(mcp.url);
  let headers: Record<string, string> = {};
  let secrets = new Map<string, string>();
  let authProvider: OAuthClientProvider | undefined;
  if (mcp.oauth?.enabled) {
    // OAuth mode: the transport owns the Authorization header + silent
    // refresh via the provider; a needed re-authorization surfaces as a
    // teaching error from the provider (a tool call can't open a browser).
    const store = oauthStoreFactory(ownerId, groupSlug);
    authProvider = runtimeMcpOAuthProvider(store, mcp.oauth.redirectUri);
    const tokens = await loadMcpOAuthTokens(store);
    if (tokens?.access_token) secrets.set(`${groupSlug}/oauth`, tokens.access_token);
  } else {
    ({ headers, secrets } = await resolveAuth(ownerId, mcp));
  }
  const transport = new StreamableHTTPClientTransport(new URL(mcp.url), {
    requestInit: { headers },
    fetch: guardedFetch,
    ...(authProvider ? { authProvider } : {}),
  });
  const client = new Client({ name: 'mantle-mcp-connector', version: '1.0.0' });
  await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
  return {
    client: Promise.resolve(client),
    fingerprint: fingerprintOf(mcp),
    idleTimer: null,
    secrets,
  };
}

function isClosedError(err: unknown): boolean {
  const msg = errorMessage(err);
  return /closed|not connected|ECONNRESET|EPIPE|disconnected|session/i.test(msg);
}

function bumpIdle(key: string, entry: Entry): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    if (cache.get(key) === entry) cache.delete(key);
    void entry.client.then((c) => c.close()).catch(() => {});
  }, IDLE_SHUTDOWN_MS);
  entry.idleTimer.unref?.();
}

async function getEntry(
  ownerId: string,
  groupSlug: string,
  mcp: ToolGroupMcpBinding,
): Promise<Entry> {
  const key = `${ownerId}/${groupSlug}`;
  const existing = cache.get(key);
  if (existing && existing.fingerprint === fingerprintOf(mcp)) {
    bumpIdle(key, existing);
    return existing;
  }
  if (existing) await closeMcpClient(ownerId, groupSlug);
  const fresh = await spawn(ownerId, groupSlug, mcp);
  cache.set(key, fresh);
  bumpIdle(key, fresh);
  return fresh;
}

/** Drop + close the cached client for a connector (config change, delete). */
export async function closeMcpClient(ownerId: string, groupSlug: string): Promise<void> {
  const key = `${ownerId}/${groupSlug}`;
  const entry = cache.get(key);
  if (!entry) return;
  cache.delete(key);
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  await entry.client.then((c) => c.close()).catch(() => {});
}

/** Run an op against the connector's client; on a dead-connection error,
 *  respawn once and retry — mirrors the dev-console bridge. */
async function withClient<T>(
  ownerId: string,
  groupSlug: string,
  mcp: ToolGroupMcpBinding,
  fn: (client: Client, secrets: Map<string, string>) => Promise<T>,
): Promise<T> {
  const entry = await getEntry(ownerId, groupSlug, mcp);
  try {
    return await fn(await entry.client, entry.secrets);
  } catch (err) {
    if (!isClosedError(err)) throw scrubbedError(err, entry.secrets);
    await closeMcpClient(ownerId, groupSlug);
    const fresh = await getEntry(ownerId, groupSlug, mcp);
    try {
      return await fn(await fresh.client, fresh.secrets);
    } catch (err2) {
      throw scrubbedError(err2, fresh.secrets);
    }
  }
}

/** An upstream error can echo the auth header (401 bodies, proxy pages) —
 *  strip the plaintext before the message travels toward the model. */
function scrubbedError(err: unknown, secrets: Map<string, string>): Error {
  const msg = errorMessage(err);
  return new Error(scrubSecrets(msg, secrets));
}

/** List the remote server's tools (for the connector sync). */
export async function mcpListRemoteTools(
  ownerId: string,
  groupSlug: string,
  mcp: ToolGroupMcpBinding,
): Promise<{ tools: McpRemoteTool[]; serverInfo?: { name?: string; version?: string } }> {
  return withClient(ownerId, groupSlug, mcp, async (client) => {
    const res = await client.listTools(undefined, { timeout: MCP_CALL_TIMEOUT_MS });
    const version = client.getServerVersion();
    return {
      tools: res.tools.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: (t.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
      })),
      ...(version ? { serverInfo: { name: version.name, version: version.version } } : {}),
    };
  });
}

/** Invoke one remote tool. The DISPATCHER owns capping + untrusted flagging +
 *  secret scrubbing of what comes back; this returns the raw outcome plus the
 *  connection's secret map so the scrub can run. */
export async function mcpCallRemoteTool(
  ownerId: string,
  groupSlug: string,
  mcp: ToolGroupMcpBinding,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallOutcome & { secrets: Map<string, string> }> {
  return withClient(ownerId, groupSlug, mcp, async (client, secrets) => {
    const res = await client.callTool({ name: toolName, arguments: args }, undefined, {
      timeout: MCP_CALL_TIMEOUT_MS,
    });
    const content = Array.isArray(res.content) ? res.content : [];
    const text = content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String(c.text) : ''))
      .filter(Boolean)
      .join('\n');
    return {
      isError: res.isError === true,
      text,
      ...(res.structuredContent !== undefined ? { structured: res.structuredContent } : {}),
      secrets,
    };
  });
}
