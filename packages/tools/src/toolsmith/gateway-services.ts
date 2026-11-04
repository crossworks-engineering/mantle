/**
 * The service gateway's registry over MCP (docs/gateway.md; Data sources
 * plan, phase 1a): list the services the gateway may route to with their
 * latest calls, and register, edit or switch one off. The same writes as
 * /api/gateway-services, through @mantle/db service-gateway.ts (its checks,
 * the full-route spot tool-config).
 *
 * `mcpOnly`: an Admin user's own client registers a service; no in-brain
 * agent is granted these (a row decides where calls go, as a tool group's
 * integration does). The connectors area, as MCP connectors.
 */
import { env } from '@mantle/config';
import {
  gatewayCallCounts,
  listGatewayCalls,
  listGatewayServices,
  setGatewayService,
} from '@mantle/db';
import type { GatewayCallRow, GatewayServiceRow } from '@mantle/db';
import { actingLoginId } from '../surface';
import type { BuiltinToolDef, ToolHandlerResult } from '../types';
import { CS } from '../client-sourced-rule';

function serviceOut(r: GatewayServiceRow, gatewayUrl: string | null) {
  return {
    slug: r.slug,
    name: r.name,
    upstream: r.upstream,
    path_prefixes: r.pathPrefixes,
    methods: r.methods,
    reads_only: r.readsOnly,
    enabled: r.enabled,
    note: r.note,
    url: gatewayUrl ? `${gatewayUrl}/svc/${r.slug}/` : null,
    updated_at: r.updatedAt.toISOString(),
  };
}

function callOut(c: GatewayCallRow) {
  return {
    at: c.createdAt.toISOString(),
    slug: c.serviceSlug,
    method: c.method,
    path: c.path,
    status: c.status,
    refusal: c.refusal,
    ms: c.durationMs,
    bytes_in: c.requestBytes,
    bytes_out: c.responseBytes,
    caller: c.caller,
  };
}

function gatewayBase(): string | null {
  const raw = env('GATEWAY_URL');
  return raw ? raw.replace(/\/+$/, '') : null;
}

export const gateway_service_list: BuiltinToolDef = {
  slug: 'gateway_service_list',
  mcpOnly: true,
  policy: {
    effect: 'read',
    spends: 'none',
    scope: { area: 'connectors', systemWhole: true },
    recipe: { step: 'forbidden' },
  },
  name: 'List gateway services',
  description:
    "List the box services the service gateway may route to (slug, upstream on mantle_services, allowed paths and methods, reads-only mark, switch) with the URL an http tool or MCP connector uses for each, and the gateway's calls of the last `hours`, counted by service, status and refusal. Paths and callers (a path can name a client record) only with `call_detail: true`. To register or change one use `gateway_service_set`.",
  inputSchema: {
    type: 'object',
    properties: {
      slug: { type: 'string', description: "Only this service, e.g. 'billing'." },
      hours: {
        type: 'integer',
        minimum: 1,
        maximum: 2160,
        default: 24,
        description: 'How far back the call counts reach.',
      },
      call_detail: {
        type: 'boolean',
        default: false,
        description: 'Also the newest calls one by one: path, status, caller.',
      },
      calls: {
        type: 'integer',
        minimum: 1,
        maximum: 200,
        default: 20,
        description: 'How many calls `call_detail` returns.',
      },
    },
  },
  handler: async (input): Promise<ToolHandlerResult> => {
    const slug = typeof input.slug === 'string' && input.slug ? input.slug : undefined;
    const hours = typeof input.hours === 'number' ? input.hours : 24;
    const detail = input.call_detail === true;
    const limit = typeof input.calls === 'number' ? input.calls : 20;
    const base = gatewayBase();
    const services = await listGatewayServices();
    const counts = await gatewayCallCounts({ slug, hours });
    const calls = detail ? await listGatewayCalls({ slug, limit }) : null;
    return {
      ok: true,
      output: {
        gateway_url: base,
        services: services.filter((s) => !slug || s.slug === slug).map((s) => serviceOut(s, base)),
        call_counts: counts.map((c) => ({ ...c, last: c.last.toISOString() })),
        ...(calls ? { calls: calls.map(callOut) } : {}),
      },
    };
  },
};

export const gateway_service_set: BuiltinToolDef = {
  slug: 'gateway_service_set',
  mcpOnly: true,
  policy: {
    matrix: { none: 'a gateway service is not an item' },
    effect: 'write',
    spends: 'none',
    scope: { area: 'connectors', systemWhole: true },
    peerRisky: true,
    idempotent: true, // a set
    destructive: true, // an edit replaces the values it names; nothing keeps the old ones
    recipe: { step: 'forbidden' },
    clientSourced: CS.always('changes where the service gateway sends calls'),
  },
  name: 'Register or change a gateway service',
  description:
    "Register a box service with the service gateway, or change one: after this, an http tool or MCP connector reaches it at `${GATEWAY_URL}/svc/<slug>/...` (the reply's `url`), and nothing else does. A new service needs `upstream`, its own container name and port on the internal network mantle_services; the gateway refuses the stack's own services and any address off that network. Fields left out keep their value (a new service: all paths, GET only, reads-only). `enabled: false` switches it off within five seconds (the gateway keeps its list that long). Store the service's own key in the vault and put it on the tool or connector; the gateway holds none. To see what is registered use `gateway_service_list`.",
  inputSchema: {
    type: 'object',
    properties: {
      slug: {
        type: 'string',
        pattern: '^[a-z0-9][a-z0-9-]{0,39}$',
        description: "The URL segment after /svc/, e.g. 'billing'.",
      },
      name: {
        type: 'string',
        maxLength: 120,
        description: "Display name, e.g. 'Billing snapshot'.",
      },
      upstream: {
        type: 'string',
        maxLength: 200,
        description: "host:port on mantle_services, e.g. 'billing-agent:8080'.",
      },
      path_prefixes: {
        type: 'array',
        items: { type: 'string', maxLength: 200 },
        minItems: 1,
        maxItems: 20,
        description:
          'The paths below the slug it may be called on; a prefix matches on a segment boundary, e.g. ["/mcp"] or ["/api/"]. Replaces the list.',
      },
      methods: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        },
        minItems: 1,
        maxItems: 7,
        description: 'The methods it may be called with, e.g. ["POST"] for an MCP server.',
      },
      reads_only: {
        type: 'boolean',
        description:
          "Your mark that the service only reads (shown; the service's own login enforces it).",
      },
      enabled: { type: 'boolean', description: 'false switches it off; true back on.' },
      note: { type: ['string', 'null'], maxLength: 500, description: 'What it is, for the owner.' },
    },
    required: ['slug'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const slug = String(input.slug ?? '');
    const res = await setGatewayService(
      slug,
      {
        ...(typeof input.name === 'string' ? { name: input.name } : {}),
        ...(typeof input.upstream === 'string' ? { upstream: input.upstream } : {}),
        ...(Array.isArray(input.path_prefixes)
          ? { pathPrefixes: input.path_prefixes.map(String) }
          : {}),
        ...(Array.isArray(input.methods) ? { methods: input.methods.map(String) } : {}),
        ...(typeof input.reads_only === 'boolean' ? { readsOnly: input.reads_only } : {}),
        ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
        ...(input.note === null || typeof input.note === 'string' ? { note: input.note } : {}),
      },
      actingLoginId(ctx.surface),
    );
    if (!res.ok) return { ok: false, error: res.error };
    return {
      ok: true,
      output: { created: res.created, service: serviceOut(res.row, gatewayBase()) },
    };
  },
};

/** Registered on the MCP surface (build-server.ts); no agent is granted
 *  them. */
export const GATEWAY_SERVICE_TOOLS: readonly BuiltinToolDef[] = [
  gateway_service_list,
  gateway_service_set,
];
