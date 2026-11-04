/**
 * What the gateway decides for one request, with no I/O: the slug and the
 * path below it from the raw request target, and whether a registered
 * service allows that method and path. A refusal names a fixed code (the
 * call log's `refusal`) and the status the brain gets.
 *
 * The raw target is read as sent, never decoded and never normalised by a
 * URL parser: a target the parser would rewrite (`..`, `.`, an empty
 * segment, a backslash, an encoded `/`, `\` or `.`) is refused, so the
 * path checked is the path the service gets.
 */
import { GATEWAY_SLUG_RE } from '@mantle/db';

/** The fields of a service row the decision reads. */
export type RouteService = Readonly<{
  slug: string;
  upstream: string;
  pathPrefixes: readonly string[];
  methods: readonly string[];
  enabled: boolean;
}>;

export type Refusal = Readonly<{ status: number; code: string; error: string }>;

export type Target = Readonly<{ slug: string; path: string; query: string }>;

/** The fixed refusals. */
export const REFUSALS = {
  notGateway: { status: 404, code: 'not_found', error: 'only /svc/<slug>/<path> is served' },
  badPath: {
    status: 400,
    code: 'bad_path',
    error: 'the path holds a segment the gateway refuses (.., ., empty, \\ or an encoded / \\ .)',
  },
  unknown: {
    status: 404,
    code: 'unknown_service',
    error: 'no service is registered with that slug',
  },
  disabled: { status: 403, code: 'service_disabled', error: 'the service is switched off' },
  method: {
    status: 405,
    code: 'method_not_allowed',
    error: 'the service does not allow that method',
  },
  pathNotAllowed: {
    status: 403,
    code: 'path_not_allowed',
    error: 'the service does not allow that path',
  },
  auth: { status: 401, code: 'unauthorized', error: 'missing or invalid gateway token' },
  noToken: {
    status: 503,
    code: 'no_token',
    error: 'GATEWAY_TOKEN is not set on this box: the gateway serves no service until it is',
  },
  upstream: {
    status: 502,
    code: 'upstream_refused',
    error: "the service's address is not on the mantle_services network",
  },
  unreachable: { status: 502, code: 'upstream_unreachable', error: 'the service did not answer' },
  timeout: { status: 504, code: 'upstream_timeout', error: 'the service took too long' },
  tooLarge: { status: 413, code: 'too_large', error: 'the request body is too large' },
  failed: { status: 502, code: 'gateway_error', error: 'the gateway failed on this call' },
} as const satisfies Record<string, Refusal>;

/** Encoded forms that would turn into a separator or a dot segment. */
const ENCODED_TRICK = /%(2f|5c|2e|00)/i;

/** The slug and the path below it, or a refusal. */
export function parseTarget(raw: string): Target | Refusal {
  if (!raw.startsWith('/svc/')) return REFUSALS.notGateway;
  const q = raw.indexOf('?');
  const pathPart = q === -1 ? raw : raw.slice(0, q);
  const query = q === -1 ? '' : raw.slice(q);
  if (pathPart.includes('\\') || pathPart.includes('#') || ENCODED_TRICK.test(pathPart)) {
    return REFUSALS.badPath;
  }
  const after = pathPart.slice('/svc/'.length);
  const slash = after.indexOf('/');
  const slug = slash === -1 ? after : after.slice(0, slash);
  if (!GATEWAY_SLUG_RE.test(slug)) return REFUSALS.unknown;
  const path = slash === -1 ? '/' : after.slice(slash);
  const segs = path.split('/').slice(1);
  // A trailing slash leaves one empty last segment, which is fine.
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    if (s === '.' || s === '..') return REFUSALS.badPath;
    if (s === '' && i !== segs.length - 1) return REFUSALS.badPath;
  }
  return { slug, path, query };
}

/** Whether `path` lies under `prefix`, on a segment boundary: `/api`
 *  allows `/api` and `/api/x`, not `/apix`; `/api/` allows `/api/x`. */
export function underPrefix(path: string, prefix: string): boolean {
  if (prefix === '/') return true;
  if (prefix.endsWith('/')) return path.startsWith(prefix);
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Whether the service allows the call, or the refusal. */
export function decide(
  service: RouteService | null,
  method: string,
  path: string,
): { ok: true } | Refusal {
  if (!service) return REFUSALS.unknown;
  if (!service.enabled) return REFUSALS.disabled;
  if (!service.methods.includes(method.toUpperCase())) return REFUSALS.method;
  if (!service.pathPrefixes.some((p) => underPrefix(path, p))) return REFUSALS.pathNotAllowed;
  return { ok: true };
}

export function isRefusal(v: unknown): v is Refusal {
  return typeof v === 'object' && v !== null && 'code' in v && 'status' in v;
}
