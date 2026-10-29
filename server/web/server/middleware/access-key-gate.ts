import {
  auditKeyRefusal,
  countFailedKey,
  failedKeyBudget,
  isApiV1Path,
  rateLimitAccessKey,
  rateLimitKeySearch,
  touchAccessKey,
  verifyAccessKey,
  type AccessKeyGrant,
} from '../../lib/access-keys';
import { requestMetaFrom } from '../../lib/audit';
import { keyOnRow, type RouteRow } from '../../lib/auth/route-policy';
import { clientIp, clientIpKey } from '../../lib/rate-limit';
import { rateLimitedResponse } from '../../lib/route-limits';
import { CACHE_CONTROL } from '../../lib/cache-control';

/**
 * The gate's answer to an `mtlk_` bearer (inbound API keys, plan page
 * 1e62e204). A key is accepted on /api/v1/* only (/api/mcp is a public
 * path and checks keys itself, lib/mcp-auth.ts). Anywhere else under /api
 * it is no credential: 401, whatever cookie rides along; a known key there
 * leaves a key.refused row (`not-v1`).
 *
 * Order on /api/v1: the failed-try budget of this address and key prefix
 * (only failures count, so a valid key is never locked out by someone
 * else's bad keys), then the key (shape, hash in constant time, revoke,
 * expiry, login), then the key's own rate budget, then its scope on the
 * request's ROUTE_POLICY row (`row`, the one the gate middleware found:
 * the v1 table's area and access as the row carries them, keyMayCall in
 * lib/api-v1.ts; no row, or a raw path that does not spell the row's
 * pattern: not in the API). Only a key that passes
 * every step is handed on (`grant`): the request context carries it, and
 * the route's login lookup (lib/auth/session.ts) takes a key from there
 * and nowhere else.
 *
 * A bad key never learns which check failed: 401 `unauthorized` for every
 * one. A good key out of its scope gets 403 with the reason (`key-area`,
 * `key-read-only`); a path that is not in the v1 table is a 404.
 */
export async function gateAccessKey(
  req: Request,
  path: string,
  token: string,
  row: RouteRow | null,
): Promise<{ grant: AccessKeyGrant } | { response: Response }> {
  const ip = clientIp(req);
  // The budgets key on the /64 for IPv6; the last-use stamp
  // keeps the real address.
  const ipKey = clientIpKey(req);
  const meta = () => ({ method: req.method, path, ...requestMetaFrom(req) });

  const budget = failedKeyBudget(ipKey, token);
  if (!budget.ok) return { response: tooMany(budget.retryAfterSec) };

  const check = await verifyAccessKey(token);
  if (!check.ok) {
    countFailedKey(ipKey, token);
    if (check.keyId) auditKeyRefusal({ keyId: check.keyId, reason: check.reason, ...meta() });
    return { response: unauthorized() };
  }
  const grant = check.grant;

  if (!isApiV1Path(path)) {
    auditKeyRefusal({ keyId: grant.id, reason: 'not-v1', ...meta() });
    return { response: unauthorized() };
  }

  const limit = rateLimitAccessKey(grant, 'v1');
  if (!limit.ok) return { response: tooMany(limit.retryAfterSec) };

  // The key's scope on the request's row. A request whose row the key
  // table does not list (or that no route answers), or whose raw path
  // does not spell the row's pattern (an encoded spelling:
  // requestKeyRoute), is a 404: it is not part of the API a key can call.
  const scope = keyOnRow(grant, row, path);
  if (!scope.ok) {
    if (scope.reason === 'not-in-api') return { response: notFound() };
    auditKeyRefusal({ keyId: grant.id, reason: scope.reason, ...meta() });
    return { response: outOfScope(scope.reason) };
  }
  // Search embeds the query on every call: a smaller budget of its own.
  if (row?.pattern === '/api/v1/search') {
    const search = rateLimitKeySearch(grant.id);
    if (!search.ok) return { response: tooMany(search.retryAfterSec) };
  }

  touchAccessKey(grant.id, ip);
  return { grant };
}

function unauthorized(): Response {
  return Response.json(
    { error: 'unauthorized' },
    { status: 401, headers: { 'Cache-Control': CACHE_CONTROL.none } },
  );
}

function notFound(): Response {
  return Response.json(
    { error: 'not found' },
    { status: 404, headers: { 'Cache-Control': CACHE_CONTROL.none } },
  );
}

function outOfScope(reason: string): Response {
  return Response.json(
    {
      error: 'forbidden',
      reason,
      message:
        reason === 'key-read-only'
          ? 'This API key is read only.'
          : "This route is outside this API key's areas.",
    },
    { status: 403, headers: { 'Cache-Control': CACHE_CONTROL.none } },
  );
}

/** A key over its budget (lib/access-keys.ts: per key, per login, the
 *  search's own): the one 429, in its machine shape: an API key's script
 *  reads `error` as the code `rate_limited`. */
function tooMany(retryAfterSec: number): Response {
  return rateLimitedResponse(retryAfterSec, 'machine');
}
