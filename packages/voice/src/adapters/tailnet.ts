/**
 * Tailnet proxy dispatch — routes a model call to a host on your Tailscale
 * tailnet (a box behind NAT, e.g. a home GPU) through the bundled Tailscale
 * HTTP forward-proxy, so the cloud VPS can reach it by MagicDNS name.
 *
 * Only adapters whose route is flagged "via tailnet" call {@link tailnetFetch};
 * everything else uses the normal global fetch and never touches this. When no
 * proxy is configured (`MANTLE_TAILNET_PROXY_URL` unset — the default), this
 * degrades to a DIRECT fetch rather than failing, so a route flagged "via
 * tailnet" but actually LAN-reachable still works.
 *
 * We use undici's OWN `fetch` + `ProxyAgent` (one instance) rather than passing
 * an installed-undici dispatcher into Node's global fetch — that keeps the
 * dispatcher and the fetch from the same undici, avoiding cross-instance
 * mismatch.
 *
 * NOTE: the end-to-end proxy path can only be verified against a live tailnet.
 * The unit tests cover the SELECTION logic (proxy-configured vs direct
 * fallback); the actual NAT traversal is validated by the operator once their
 * tailnet is up.
 */

import { fetch as undiciFetch, ProxyAgent } from 'undici';

let _agent: ProxyAgent | null | undefined; // undefined = unresolved; null = none

function proxyAgent(): ProxyAgent | null {
  if (_agent !== undefined) return _agent;
  const url = process.env.MANTLE_TAILNET_PROXY_URL?.trim();
  _agent = url ? new ProxyAgent(url) : null;
  return _agent;
}

/** True when a tailnet proxy is configured (the `tailnet` compose profile is on). */
export function tailnetProxyConfigured(): boolean {
  return !!process.env.MANTLE_TAILNET_PROXY_URL?.trim();
}

/**
 * Fetch routed through the tailnet HTTP forward-proxy when one is configured;
 * a plain direct fetch otherwise. Drop-in for `fetch(url, init)` in adapters
 * that honour a per-route "via tailnet" flag.
 */
export async function tailnetFetch(url: string, init?: RequestInit): Promise<Response> {
  const agent = proxyAgent();
  if (!agent) return fetch(url, init);
  // undici's RequestInit accepts `dispatcher`; the global RequestInit type
  // doesn't, hence the cast at this boundary.
  const res = await undiciFetch(url, { ...(init as object), dispatcher: agent } as Parameters<
    typeof undiciFetch
  >[1]);
  return res as unknown as Response;
}

/** Test seam — clears the cached agent so an env change takes effect. */
export function _resetTailnetProxy(): void {
  _agent = undefined;
}
