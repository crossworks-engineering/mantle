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
 */

const MAX_REDIRECTS = 5;

/** Stripped by name on a cross-origin hop, matching standard fetch behavior. */
const CROSS_ORIGIN_STRIP = new Set(['authorization', 'cookie', 'proxy-authorization']);

function headerRecord(init: HeadersInit | undefined): Record<string, string> {
  if (!init) return {};
  if (init instanceof Headers) return Object.fromEntries(init.entries());
  if (Array.isArray(init)) return Object.fromEntries(init);
  return { ...init };
}

export async function safeFetch(
  url: string,
  init: RequestInit,
  secretValues: string[],
): Promise<Response> {
  const carriers = secretValues.filter((s) => s.length > 0);
  let currentUrl = url;
  let method = (init.method ?? 'GET').toUpperCase();
  let headers = headerRecord(init.headers);
  let body = init.body;

  for (let hop = 0; ; hop++) {
    const res = await fetch(currentUrl, { ...init, method, headers, body, redirect: 'manual' });
    if (res.status < 300 || res.status >= 400) return res;

    const location = res.headers.get('location');
    if (!location) return res; // 3xx without a target — hand it back unchanged
    if (hop >= MAX_REDIRECTS) throw new Error(`too many redirects (>${MAX_REDIRECTS})`);

    const next = new URL(location, currentUrl);
    if (next.origin !== new URL(currentUrl).origin) {
      headers = Object.fromEntries(
        Object.entries(headers).filter(
          ([k, v]) => !CROSS_ORIGIN_STRIP.has(k.toLowerCase()) && !carriers.some((s) => v.includes(s)),
        ),
      );
    }

    // Method/body downgrade, matching the platform: 303 always → GET; a 301/302
    // on POST downgrades to GET. 307/308 preserve method and body.
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
      method = 'GET';
      body = undefined;
      headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !/^content-/i.test(k)));
    }

    currentUrl = next.toString();
  }
}
