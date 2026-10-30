/**
 * The RFC 8707 `resource` value on the connector's OAuth flow.
 *
 * A client names the MCP server it wants a token for: ChatGPT sends the
 * `resource` of the protected resource metadata (mcpResourceUrl) on the
 * authorization request and on the token requests, and the MCP spec asks
 * every client to. Mantle's access tokens are opaque handles to a row in
 * this box's database, honoured only at this box's `/api/mcp`, so a token
 * is bound to that one resource whatever the client sent: there is no
 * `aud` claim to copy the value into.
 *
 * What this module does with the value: it checks that it names this
 * box's MCP endpoint, and logs one line when it does not. It never
 * refuses (corporate plan, section 2.1): a Claude connector that sends no
 * value, or an old host name the box still serves, works as it did.
 */
import { publicBaseUrl } from '@mantle/content';
import { log } from '@mantle/tracing';

const oauthLog = log('mcp-oauth');

/** The MCP endpoint's path on the box (the resource the tokens are for). */
export const MCP_RESOURCE_PATH = '/api/mcp';

/** Where in the flow a value was read, for the log line. */
export type ResourceStep = 'authorize' | 'code exchange' | 'refresh';

/** The longest value a log line repeats: it is the client's own text. */
const LOGGED_MAX = 200;

/**
 * The comparable form of a resource URI, or null when it is not an
 * absolute URI. `URL` lowercases the scheme and host and drops a default
 * port; a trailing slash on the path is dropped too (the MCP spec's
 * canonical form). A query or fragment is kept, so a value carrying one
 * never matches: RFC 8707 forbids the fragment, and this box's resource
 * has neither.
 */
export function canonicalResource(value: string): string | null {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}${u.search}${u.hash}`;
}

/**
 * Does `value` name this box's MCP endpoint? The box is named by its
 * public URL and by the origin the request came in on (an old host name
 * the box still serves). The bare origin counts too: the MCP spec allows
 * a client to name the server by it.
 */
export function resourceNamesThisBox(value: string, requestOrigin?: string): boolean {
  const asked = canonicalResource(value);
  if (!asked) return false;
  for (const origin of [publicBaseUrl(), requestOrigin]) {
    if (!origin) continue;
    const base = canonicalResource(origin);
    if (!base) continue;
    if (asked === base || asked === `${base}${MCP_RESOURCE_PATH}`) return true;
  }
  return false;
}

/** The value as a log line may carry it: printable ASCII, clipped. */
function printable(value: string): string {
  const flat = value.replace(/[^\x20-\x7e]/g, '?');
  return flat.length > LOGGED_MAX ? `${flat.slice(0, LOGGED_MAX)}...` : flat;
}

/**
 * Check every `resource` value of one request (RFC 8707 allows several)
 * and log each that does not name this box. Never refuses: the caller
 * goes on as if no value had been sent. No value at all is not logged.
 */
export function noteResource(
  values: readonly unknown[],
  step: ResourceStep,
  requestOrigin?: string,
): void {
  for (const v of values) {
    if (typeof v !== 'string') continue;
    if (resourceNamesThisBox(v, requestOrigin)) continue;
    oauthLog.warn(
      `resource mismatch at ${step}: "${printable(v)}" does not name ` +
        `${publicBaseUrl()}${MCP_RESOURCE_PATH}; not refused`,
    );
  }
}
