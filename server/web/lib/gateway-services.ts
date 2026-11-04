/**
 * The service gateway's registry and call log on the wire
 * (/api/gateway-services; docs/gateway.md). The rows are @mantle/db's; a
 * service carries the URL an http tool or MCP connector uses for it.
 */
import { env } from '@mantle/config';
import type { GatewayCallRow, GatewayServiceRow } from '@mantle/db';

export function gatewayServiceOut(r: GatewayServiceRow) {
  const base = env('GATEWAY_URL')?.replace(/\/+$/, '') ?? null;
  return {
    slug: r.slug,
    name: r.name,
    upstream: r.upstream,
    pathPrefixes: r.pathPrefixes,
    methods: r.methods,
    readsOnly: r.readsOnly,
    enabled: r.enabled,
    note: r.note,
    url: base ? `${base}/svc/${r.slug}/` : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function gatewayCallOut(c: GatewayCallRow) {
  return {
    at: c.createdAt.toISOString(),
    slug: c.serviceSlug,
    method: c.method,
    path: c.path,
    status: c.status,
    refusal: c.refusal,
    durationMs: c.durationMs,
    requestBytes: c.requestBytes,
    responseBytes: c.responseBytes,
    caller: c.caller,
    loginId: c.loginId,
  };
}
