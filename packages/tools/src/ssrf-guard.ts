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

import { assertEgressUrl, egressFetch, isBlockedIp as egressBlocked } from '@mantle/std/egress';
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

/** Throw if `rawUrl` is not an http(s) URL whose host resolves only to public
 *  addresses. Used before every fetch hop. The check is the egress
 *  module's (@mantle/std/egress); the sandbox proxy carve is this
 *  package's. */
export async function assertFetchableUrl(rawUrl: string): Promise<void> {
  await assertEgressUrl(rawUrl, { exempt: isSandboxProxyUrl });
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
    guard: assertFetchableUrl,
    exempt: isSandboxProxyUrl,
    ...opts,
  });
}
