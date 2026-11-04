/**
 * SSRF guard for agent-driven fetches (web_fetch and anything else that lets a
 * model choose a URL). Blocks loopback / private / link-local / CGNAT / cloud-
 * metadata / reserved addresses so an injected agent can't reach
 * `http://169.254.169.254/...`, an internal service, or a tailnet peer — and
 * re-checks the target after every redirect hop.
 *
 * DNS rebinding: the connection itself is pinned to checked addresses
 * (@mantle/std/egress resolves again at connect and refuses a private
 * answer), so a name that answers public to the check and private to the
 * connect is refused.
 */

import {
  assertEgressUrl,
  EgressRefusedError,
  egressFetch,
  isBlockedIp as egressBlocked,
} from '@mantle/std/egress';
import { env } from '@mantle/config';

/** Is a literal IP in a blocked range? Unparseable → blocked (fail closed).
 *  The ranges live in @mantle/std/egress. */
export function isBlockedIp(ip: string): boolean {
  return egressBlocked(ip);
}

/**
 * THE ONE DELIBERATE EXEMPTION: the sandboxd service proxy.
 *
 * Services built inside CLI sandboxes are reachable only through sandboxd's
 * reverse proxy (`${SANDBOXD_URL}/svc/<sandbox-id>/<port>/…`), and sandboxd is
 * by design a private-network host — so without a carve, sandbox-service
 * integrations could never execute. The carve is the narrowest one that
 * works, and BOTH bounds matter:
 *   - origin must equal SANDBOXD_URL's origin EXACTLY (no other private host
 *     inherits it — postgres/objectstore/web stay blocked);
 *   - path must start with `/svc/` — sandboxd's CONTROL verbs (/sandboxes,
 *     create/exec/rm) remain unreachable to model-driven fetches; only the
 *     data-plane proxy is exposed, and it is itself bearer-token-gated and
 *     restricted to explicitly published ports.
 * Guarded by ssrf-guard.test.ts; if you widen this, you are re-deciding a
 * security boundary — stop and take it to the owner first.
 */
export function isSandboxProxyUrl(u: URL): boolean {
  const base = env('SANDBOXD_URL');
  if (!base) return false;
  try {
    return u.origin === new URL(base).origin && u.pathname.startsWith('/svc/');
  } catch {
    return false;
  }
}

/**
 * THE SECOND DELIBERATE EXEMPTION: the service gateway (docs/gateway.md).
 *
 * The services of a box (a client database's query face, an MCP bridge)
 * sit on the internal network mantle_services, publish no port and have no
 * Caddy route; the gateway (server/gateway) is the one door to them and
 * routes `${GATEWAY_URL}/svc/<slug>/…` only to a service the owner
 * registered. The carve is exactly the sandboxd one, and BOTH bounds
 * matter:
 *   - origin must equal GATEWAY_URL's origin EXACTLY (no other private host
 *     inherits it);
 *   - path must start with `/svc/` and name a slug: the gateway serves
 *     nothing else (it answers /healthz alone without its token).
 * The gateway is itself token-gated (GATEWAY_TOKEN, which the brain sends
 * only on an http tool's or an MCP connector's call, never on web_fetch)
 * and refuses an unknown slug, method or path. Every hop of a call that
 * starts here must stay on the same service, and no hop may enter it
 * (hopGuard). Guarded by ssrf-guard.test.ts; if you widen this, you are
 * re-deciding a security boundary — stop and take it to the owner first.
 */
export function isGatewayUrl(u: URL): boolean {
  return gatewaySlug(u) !== null;
}

/** The service slug of a gateway URL (`${GATEWAY_URL}/svc/<slug>/…`), or
 *  null for any other URL. */
export function gatewaySlug(u: URL): string | null {
  const base = env('GATEWAY_URL');
  if (!base) return null;
  try {
    if (u.origin !== new URL(base).origin) return null;
  } catch {
    return null;
  }
  const m = /^\/svc\/([a-z0-9][a-z0-9-]{0,39})(?:\/|$)/.exec(u.pathname);
  return m ? m[1]! : null;
}

/** The two carves: a URL either one accepts skips the address check and the
 *  connect-time pin (@mantle/std/egress `exempt`). */
export function isCarvedUrl(u: URL): boolean {
  return isSandboxProxyUrl(u) || isGatewayUrl(u);
}

/** Throw if `rawUrl` is not an http(s) URL whose host resolves only to public
 *  addresses. Used before every fetch hop. The check is the egress
 *  module's (@mantle/std/egress); the sandbox proxy and gateway carves are
 *  this package's. */
export async function assertFetchableUrl(rawUrl: string): Promise<void> {
  await assertEgressUrl(rawUrl, { exempt: isCarvedUrl });
}

/** The check with no carve: for a URL handed to a third party (a cloud
 *  crawler), where an internal origin must never leave the box, carved or
 *  not. */
export async function assertPublicUrl(rawUrl: string): Promise<void> {
  await assertEgressUrl(rawUrl);
}

function parsed(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * The check for each hop of one fetch that starts at `startUrl`
 * (egressFetch calls it once per hop, in order). A call that starts at a
 * gateway service stays on that service: a redirect out of the gateway, or
 * to another service on it, is refused (the call carries the gateway token
 * and the service's key). A call that starts anywhere else is checked as
 * before, and a redirect INTO the gateway is refused: the carve is for a
 * URL a tool was written with, never one a remote server points at.
 */
export function hopGuard(startUrl: string): (url: string) => Promise<void> {
  const start = parsed(startUrl);
  const slug = start ? gatewaySlug(start) : null;
  let hop = 0;
  return async (url: string) => {
    const first = hop++ === 0;
    const u = parsed(url);
    if (slug !== null) {
      if (!u || gatewaySlug(u) !== slug) {
        throw new EgressRefusedError(
          `refusing a redirect out of gateway service '${slug}' (to ${u ? u.origin : 'an invalid URL'}): a gateway call stays on its service`,
        );
      }
      return;
    }
    if (!first && u && isGatewayUrl(u)) {
      throw new EgressRefusedError(
        'refusing a redirect into the service gateway: only a URL a tool was written with may reach it',
      );
    }
    await assertFetchableUrl(url);
  };
}

/**
 * fetch that runs the SSRF guard on the initial URL and on every redirect
 * target (following manually so a public URL can't 302 into private space).
 * Through the one egress fetch (egressFetch), so a hop to another
 * origin also drops Authorization and cookies.
 */
export async function guardedFetch(
  url: string,
  init: RequestInit = {},
  maxRedirects = 5,
  opts: { maxBytes?: number; overflow?: 'error' | 'truncate' } = {},
): Promise<Response> {
  return egressFetch(url, init, {
    maxRedirects,
    guard: hopGuard(url),
    exempt: isCarvedUrl,
    ...opts,
  });
}
