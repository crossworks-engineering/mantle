/**
 * The service gateway's registry and call log (migration 0358;
 * docs/gateway.md). The gateway (server/gateway) routes `/svc/<slug>/<path>`
 * only to an enabled `gateway_services` row, with a method and a path that
 * row allows, and writes one `gateway_calls` row per call it answered or
 * refused. Not to be confused with ./gateway/, the database gateway.
 *
 * Writes of a service (the connectors area's API and MCP tool) run at the
 * full-route spot tool-config: a row decides where calls go, as a tool
 * group's integration does. The rules a row must keep are here, once
 * (checkGatewayService), for every writer; the database's CHECKs hold the
 * same shapes against any other one.
 *
 * The call log is service-gateway-calls.ts.
 */
import { eq, getTableColumns, sql } from 'drizzle-orm';
import { UUID_RE } from '@mantle/std';
import { systemDb } from './gateway/handles';
import { onFullSystemRoute } from './viewer';
import { gatewayServices, type GatewayServiceRow } from './schema/gateway-services';

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
    return `upstream must be host:port, the service's container name on the mantle_services network (one lowercase label, no dots) and a port (got '${upstream.slice(0, 80)}'), e.g. 'pcms-agent:8080'`;
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
      error: `slug must be 1 to 40 lowercase letters, digits or dashes, starting with a letter or digit (got '${slug.slice(0, 60)}'), e.g. 'pcms'`,
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

/** Every service, by slug. */
export async function listGatewayServices(): Promise<GatewayServiceRow[]> {
  return systemDb.select().from(gatewayServices).orderBy(gatewayServices.slug);
}

/** One service by slug, or null. */
export async function getGatewayService(slug: string): Promise<GatewayServiceRow | null> {
  if (!GATEWAY_SLUG_RE.test(slug)) return null;
  const [row] = await systemDb
    .select()
    .from(gatewayServices)
    .where(eq(gatewayServices.slug, slug))
    .limit(1);
  return row ?? null;
}

const uuidOrNull = (v: string | null | undefined): string | null =>
  v && UUID_RE.test(v) ? v.toLowerCase() : null;

/** Register a service, or set every value of the one with its slug
 *  (checked values: checkGatewayService). At the full-route spot
 *  tool-config: a row decides where calls go. */
export async function saveGatewayService(
  values: GatewayServiceValues,
  by: string | null,
): Promise<{ row: GatewayServiceRow; created: boolean }> {
  const createdBy = uuidOrNull(by);
  return onFullSystemRoute('tool-config', async () => {
    const [row] = await systemDb
      .insert(gatewayServices)
      .values({ ...values, createdBy })
      .onConflictDoUpdate({
        target: gatewayServices.slug,
        set: { ...values, createdBy, updatedAt: new Date() },
      })
      .returning({ ...getTableColumns(gatewayServices), created: sql<boolean>`(xmax = 0)` });
    const { created, ...saved } = row!;
    return { row: saved, created };
  });
}

/** What a register or an edit may change: every field but the slug may be
 *  left out (an edit keeps it; a new service takes the default, and must
 *  name its upstream). */
export type GatewayServicePatch = Readonly<{
  name?: string;
  upstream?: string;
  pathPrefixes?: readonly string[];
  methods?: readonly string[];
  readsOnly?: boolean;
  enabled?: boolean;
  note?: string | null;
}>;

/** Register the service `slug`, or change the fields `patch` names of the
 *  one there: checked as a whole (checkGatewayService), then saved. */
export async function setGatewayService(
  slug: string,
  patch: GatewayServicePatch,
  by: string | null,
): Promise<{ ok: true; row: GatewayServiceRow; created: boolean } | { ok: false; error: string }> {
  const have = await getGatewayService(slug);
  if (!have && patch.upstream === undefined) {
    return {
      ok: false,
      error: `no service '${slug.slice(0, 40)}' is registered yet, so upstream is required: its host:port on mantle_services, e.g. 'pcms-agent:8080'`,
    };
  }
  const checked = checkGatewayService({
    slug,
    name: patch.name ?? have?.name,
    upstream: patch.upstream ?? have!.upstream,
    pathPrefixes: patch.pathPrefixes ?? have?.pathPrefixes,
    methods: patch.methods ?? have?.methods,
    readsOnly: patch.readsOnly ?? have?.readsOnly,
    enabled: patch.enabled ?? have?.enabled,
    note: patch.note !== undefined ? patch.note : (have?.note ?? null),
  });
  if (!checked.ok) return checked;
  return { ok: true, ...(await saveGatewayService(checked.value, by)) };
}
