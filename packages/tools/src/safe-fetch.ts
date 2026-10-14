/**
 * fetch with manual redirect following so secret-bearing headers are dropped
 * the instant a hop crosses origin.
 *
 * Why not `redirect: 'follow'`: the platform keeps custom request headers
 * (e.g. `x-api-key`, `x-goog-api-key`) across a cross-origin 3xx — only
 * `Authorization`/`Cookie`/`Proxy-Authorization` are stripped by name. A
 * malicious or misconfigured upstream could therefore 302 to an attacker host
 * and harvest a resolved `{{secret:…}}` plaintext. We follow redirects
 * ourselves, replicate the platform's by-name stripping AND drop any header
 * whose value carries a resolved secret once the origin changes.
 *
 * SSRF: this is the RUNTIME dispatch path for `http` api-tools (secret-bearing),
 * so it must apply the same egress guard as web_fetch/api_tool_test — otherwise
 * SSRF is enforced only at authoring/test time (guardedFetch) and a model-fillable
 * host, or a public endpoint that 302s to 169.254.169.254, reaches internal
 * services at execution time. We run assertFetchableUrl on the initial URL and
 * on every redirect target before connecting.
 */

import { egressFetch } from '@mantle/std/egress';
import { assertFetchableUrl } from './ssrf-guard';

/** The one egress fetch (@mantle/std/egress, A10 part 1) with this path's
 *  secrets: every hop guarded, secret-bearing headers dropped across
 *  origins, 303 and POST-on-301/302 downgraded to GET as the platform does.
 *  No deadline or byte cap of its own: the caller's `init.signal` is the
 *  deadline, and the readers cap what they read (as before the fold). */
export async function safeFetch(
  url: string,
  init: RequestInit,
  secretValues: string[],
  // Injectable ONLY so the redirect/secret-stripping tests can drive loopback
  // servers; every production caller takes the default real egress guard.
  guard: (u: string) => Promise<void> = assertFetchableUrl,
): Promise<Response> {
  return egressFetch(url, init, { secrets: secretValues, guard });
}
