/**
 * The brain's side of the service gateway (docs/gateway.md). An http tool or
 * an MCP connector whose URL is `${GATEWAY_URL}/svc/<slug>/…` reaches a box
 * service through the gateway; the egress carve itself is ssrf-guard.ts
 * (isGatewayUrl, hopGuard).
 *
 * What is added here, and only on those two paths (never on web_fetch,
 * whose URL a model chooses):
 *  - the gateway token (GATEWAY_TOKEN) in its own header, so the service's
 *    own key keeps Authorization;
 *  - who calls, for the gateway's call log: the agent or the surface, and
 *    the login the call acts for. Set per tool call (runAsGatewayCaller in
 *    dispatch.ts), so an MCP connector's shared client still names each
 *    call's caller.
 *
 * And the binding: a call carries the token only to the service its tool
 * was written for. An http tool's slug must be fixed in the URL its author
 * wrote (a model-filled `{param}` may not choose it: `/svc/a/{x}/{y}` with
 * `..` and `b` would land on service b); an MCP connector's requests must
 * stay on the slug of its own URL.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { env } from '@mantle/config';
import { EgressRefusedError } from '@mantle/std/egress';
import { actingLoginId } from './surface';
import { gatewaySlug } from './ssrf-guard';
import type { ToolHandlerContext } from './types';

/** The headers the gateway reads (server/gateway server.ts) and removes
 *  before the service sees the request. */
export const GATEWAY_TOKEN_HEADER = 'x-mantle-gateway-token';
export const GATEWAY_CALLER_HEADER = 'x-mantle-caller';
export const GATEWAY_LOGIN_HEADER = 'x-mantle-login';

export type GatewayCaller = Readonly<{ caller: string; loginId: string | null }>;

const callerNow = new AsyncLocalStorage<GatewayCaller>();

/** Who a tool call is, for the gateway's log: the agent when an agent's
 *  turn calls, else the surface kind. */
export function gatewayCallerOf(ctx: ToolHandlerContext): GatewayCaller {
  const surface = ctx.surface?.kind ?? 'system';
  const caller = ctx.agent?.slug ? `agent:${ctx.agent.slug}` : `surface:${surface}`;
  return { caller, loginId: actingLoginId(ctx.surface) };
}

/** Run `fn` with `caller` as the gateway's caller. */
export function runAsGatewayCaller<T>(caller: GatewayCaller, fn: () => T): T {
  return callerNow.run(caller, fn);
}

function parsed(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** The headers a gateway call carries: the token, the caller, its login. */
export function gatewayRequestHeaders(who: GatewayCaller): Record<string, string> {
  const out: Record<string, string> = {
    [GATEWAY_TOKEN_HEADER]: env('GATEWAY_TOKEN') ?? '',
    [GATEWAY_CALLER_HEADER]: who.caller.slice(0, 200),
  };
  if (who.loginId) out[GATEWAY_LOGIN_HEADER] = who.loginId;
  return out;
}

/** The gateway token, when this box has one (for the scrub). */
export function gatewayToken(): string | null {
  return env('GATEWAY_TOKEN') || null;
}

/**
 * An http tool's request against the gateway: null when `resolvedUrl` is no
 * gateway URL, else the slug it may carry the token to, or why not. The
 * slug must stand in the literal part of `templateUrl` (before its first
 * `{`), ended by a `/` or by the end of the template, and the resolved URL
 * (normalised, as fetch sends it) must name the same slug.
 */
export function gatewayHttpBinding(
  templateUrl: string,
  resolvedUrl: string,
): null | { slug: string } | { error: string } {
  const resolved = parsed(resolvedUrl);
  const slug = resolved ? gatewaySlug(resolved) : null;
  if (slug === null) return null;
  const brace = templateUrl.indexOf('{');
  const literal = brace === -1 ? templateUrl : templateUrl.slice(0, brace);
  const fixed = parsed(literal);
  const fixedSlug = fixed ? gatewaySlug(fixed) : null;
  const ended =
    brace === -1 ||
    (fixed !== null && fixedSlug !== null && fixed.pathname.startsWith(`/svc/${fixedSlug}/`));
  if (fixedSlug === null || !ended) {
    return {
      error:
        "refused: a gateway URL's service must be fixed in the tool's URL, as `${GATEWAY_URL}/svc/<slug>/...`, never filled from a parameter. Edit the tool's url so the slug is literal",
    };
  }
  if (fixedSlug !== slug) {
    return {
      error: `refused: this tool is written for gateway service '${fixedSlug}', but its parameters point the request at '${slug}'. Pass parameters that stay inside the service's own paths`,
    };
  }
  return { slug };
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
}

/**
 * An MCP connector's fetch: a request to a gateway service carries the
 * gateway headers when it is the service of the connector's own URL
 * (`boundUrl`), and is refused when it is another; a request anywhere else
 * goes as it is.
 */
export function gatewayConnectorFetch(
  boundUrl: string,
  groupSlug: string,
  base: typeof fetch,
): typeof fetch {
  const bound = parsed(boundUrl);
  const boundSlug = bound ? gatewaySlug(bound) : null;
  return async (input, init) => {
    const u = parsed(urlOf(input));
    const slug = u ? gatewaySlug(u) : null;
    if (slug === null) return base(input, init);
    if (slug !== boundSlug) {
      throw new EgressRefusedError(
        `refusing a request to gateway service '${slug}': connector '${groupSlug}' is bound to ${boundSlug ? `'${boundSlug}'` : 'no gateway service'}`,
      );
    }
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
    const who = callerNow.getStore() ?? { caller: `connector:${groupSlug}`, loginId: null };
    for (const [k, v] of Object.entries(gatewayRequestHeaders(who))) {
      headers.set(k, v);
    }
    return base(input, { ...init, headers });
  };
}
