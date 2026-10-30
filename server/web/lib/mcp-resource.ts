/**
 * The RFC 8707 `resource` value on the connector's OAuth flow.
 *
 * A client names the MCP server it wants a token for: ChatGPT sends the
 * `resource` of the protected resource metadata (mcpResourceUrl) on the
 * authorization request and on the token requests, and the MCP spec asks
 * every client to. Mantle's access tokens are opaque handles to a row in
 * this box's database, honoured only at this box's `/api/mcp`: there is no
 * `aud` claim to copy the value into. That binds a token to this box only
 * while the value names this box. A value that names another server means
 * the client may hand the token to that server, which could replay it
 * here.
 *
 * What this module does with the value: it checks that it names this
 * box's MCP endpoint. When it does not, the consent page says so to the
 * person who allows (foreignResource), the consent's audit row names its
 * host, and a grant logs one line (noteResource). It never refuses
 * (corporate plan, section 2.1): a Claude connector that sends no value,
 * or an old host name the box still serves, works as it did.
 */
import { publicBaseUrl } from '@mantle/content';
import { log } from '@mantle/tracing';

const oauthLog = log('mcp-oauth');

/** The MCP endpoint's path on the box (the resource the tokens are for). */
export const MCP_RESOURCE_PATH = '/api/mcp';

/** Where in the flow a value was read, for the log line. */
export type ResourceStep = 'code exchange' | 'refresh';

/** The longest value a log line or the consent page repeats: it is the
 *  client's own text. */
const SHOWN_MAX = 200;

/** How many values of one request are checked. RFC 8707 allows several,
 *  a client sends one; a request with thousands must cost no more. */
const CHECKED_MAX = 4;

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
 * a client to name the server by it. The origin is read from the request's
 * headers, so this answer only ever chooses a warning, never a refusal.
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

/** The value as a log line or a page may carry it: printable ASCII,
 *  clipped. A page escapes it as well. */
export function printableResource(value: string): string {
  const flat = value.replace(/[^\x20-\x7e]/g, '?');
  return flat.length > SHOWN_MAX ? `${flat.slice(0, SHOWN_MAX)}...` : flat;
}

/**
 * The first of a request's `resource` values that does not name this box
 * (of the first CHECKED_MAX text values), or null when every one does or
 * none was sent.
 */
export function foreignResource(values: readonly unknown[], requestOrigin?: string): string | null {
  const texts = values.filter((v): v is string => typeof v === 'string').slice(0, CHECKED_MAX);
  return texts.find((v) => !resourceNamesThisBox(v, requestOrigin)) ?? null;
}

/**
 * Log one line for a grant made for a `resource` that does not name this
 * box. The token route calls it only once the grant was made, so a
 * request with no valid code or refresh token logs nothing. Never
 * refuses.
 */
export function noteResource(
  values: readonly unknown[],
  step: ResourceStep,
  requestOrigin?: string,
): void {
  const foreign = foreignResource(values, requestOrigin);
  if (!foreign) return;
  oauthLog.warn(
    `resource mismatch at ${step}: "${printableResource(foreign)}" does not name ` +
      `${publicBaseUrl()}${MCP_RESOURCE_PATH}; not refused`,
  );
}
