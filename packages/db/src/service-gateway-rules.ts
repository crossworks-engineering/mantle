/**
 * The service gateway's registry rules (docs/gateway.md): what a
 * `gateway_services` row may hold, once, for every writer (the connectors
 * area's API and MCP tool) and for the gateway, which checks each row it is
 * given again. No database here: the gateway (server/gateway) holds no
 * database login and imports only this file (`@mantle/db/service-gateway-rules`).
 * The database's CHECKs (0358) hold the same shapes against any other writer.
 */

/** A service's slug: the URL segment after `/svc/`. */
export const GATEWAY_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** The methods a service may allow. */
export const GATEWAY_METHODS = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
] as const;
export type GatewayMethod = (typeof GATEWAY_METHODS)[number];

/** `host:port`, one DNS label (the service's container name on
 *  mantle_services; a dotted name could be a public one answering any
 *  address). The database's gateway_services_upstream_ck holds the same
 *  shape. */
const UPSTREAM_RE = /^[a-z0-9]([a-z0-9_-]{0,61}[a-z0-9])?:[0-9]{1,5}$/;

/** A path prefix: an absolute path of plain characters, no `..` or empty
 *  segment, no percent sign (an encoded `/` or `.` could step around it). */
const PREFIX_RE = /^\/[A-Za-z0-9._~\-/:@!$&'()*+,=]*$/;

/**
 * Names an upstream may not have: the stack's own services on the default
 * network (the gateway sits there too, so a row naming one would reach it),
 * their container names, and loopback. A box service has its own name on
 * mantle_services; the gateway also refuses, at connect, any address that
 * is not on that network (server/gateway upstream.ts).
 */
const STACK_NAMES = new Set([
  'localhost',
  'gateway',
  'postgres',
  'objectstore',
  'objectstore_init',
  'parser',
  'browser',
  'gotenberg',
  'ollama',
  'ollama_pull',
  'tailscale',
  'migrate',
  'web',
  'caddy',
  'updater',
  'livekit',
  'sandboxd',
  'autoheal',
  'api',
]);

function stackName(host: string): boolean {
  return (
    STACK_NAMES.has(host) ||
    host.startsWith('worker_') ||
    host.startsWith('mantle_') ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal')
  );
}

/** What a service is set to (a register or an edit). */
export type GatewayServiceInput = Readonly<{
  slug: string;
  name?: string;
  upstream: string;
  pathPrefixes?: readonly string[];
  methods?: readonly string[];
  readsOnly?: boolean;
  enabled?: boolean;
  note?: string | null;
}>;

/** A service row's values, checked. */
export type GatewayServiceValues = {
  slug: string;
  name: string;
  upstream: string;
  pathPrefixes: string[];
  methods: GatewayMethod[];
  readsOnly: boolean;
  enabled: boolean;
  note: string | null;
};

/** Is `upstream` a `host:port` the gateway may send to? null when it is,
 *  else why not (a teaching sentence). */
export function upstreamRefusal(upstream: string): string | null {
  if (!UPSTREAM_RE.test(upstream) || upstream.length > 200) {
    return `upstream must be host:port, the service's container name on the mantle_services network (one lowercase label, no dots) and a port (got '${upstream.slice(0, 80)}'), e.g. 'billing-agent:8080'`;
  }
  const i = upstream.lastIndexOf(':');
  const host = upstream.slice(0, i);
  const port = Number(upstream.slice(i + 1));
  if (!(port >= 1 && port <= 65535)) return `upstream port must be 1 to 65535 (got ${port})`;
  if (/^[0-9]+$/.test(host)) {
    return `upstream must name the service by its DNS name on mantle_services, not an IP address (got '${host}')`;
  }
  if (stackName(host)) {
    return `upstream '${host}' is one of the stack's own services, which the gateway never routes to; name the box service's own container on mantle_services`;
  }
  return null;
}

/** Is `prefix` a path prefix a service may allow? null when it is. */
export function pathPrefixRefusal(prefix: string): string | null {
  if (prefix.length > 200 || !PREFIX_RE.test(prefix)) {
    return `path prefix '${prefix.slice(0, 80)}' must be an absolute path of plain characters (no '%', '?', '#', ';' or '\\'), e.g. '/mcp' or '/api/'`;
  }
  const segs = prefix.split('/').slice(1, prefix.endsWith('/') ? -1 : undefined);
  if (prefix !== '/' && segs.some((s) => s === '' || s === '.' || s === '..')) {
    return `path prefix '${prefix}' may not hold an empty, '.' or '..' segment`;
  }
  return null;
}

/** Check a service as a writer set it: its values, or the first fault. */
export function checkGatewayService(
  input: GatewayServiceInput,
): { ok: true; value: GatewayServiceValues } | { ok: false; error: string } {
  const slug = String(input.slug ?? '');
  if (!GATEWAY_SLUG_RE.test(slug)) {
    return {
      ok: false,
      error: `slug must be 1 to 40 lowercase letters, digits or dashes, starting with a letter or digit (got '${slug.slice(0, 60)}'), e.g. 'billing'`,
    };
  }
  const upstream = String(input.upstream ?? '').trim();
  const up = upstreamRefusal(upstream);
  if (up) return { ok: false, error: up };
  const name = (input.name ?? slug).trim();
  if (name.length < 1 || name.length > 120) {
    return { ok: false, error: 'name must be 1 to 120 characters' };
  }
  const prefixes = [...new Set(input.pathPrefixes ?? ['/'])];
  if (prefixes.length < 1 || prefixes.length > 20) {
    return { ok: false, error: 'path_prefixes must list 1 to 20 prefixes, e.g. ["/mcp"]' };
  }
  for (const p of prefixes) {
    const r = pathPrefixRefusal(p);
    if (r) return { ok: false, error: r };
  }
  const methods = [...new Set((input.methods ?? ['GET']).map((m) => String(m).toUpperCase()))];
  if (methods.length < 1) return { ok: false, error: 'methods must list at least one method' };
  for (const m of methods) {
    if (!(GATEWAY_METHODS as readonly string[]).includes(m)) {
      return {
        ok: false,
        error: `method '${m.slice(0, 20)}' is not one of ${GATEWAY_METHODS.join(', ')}`,
      };
    }
  }
  const note = input.note == null ? null : String(input.note).trim() || null;
  if (note !== null && note.length > 500) {
    return { ok: false, error: 'note must be at most 500 characters' };
  }
  return {
    ok: true,
    value: {
      slug,
      name,
      upstream,
      pathPrefixes: prefixes,
      methods: methods as GatewayMethod[],
      readsOnly: input.readsOnly ?? true,
      enabled: input.enabled ?? true,
      note,
    },
  };
}
