import {
  auditKeyRefusal,
  countFailedKey,
  failedKeyBudget,
  isApiV1Path,
  rateLimitAccessKey,
  touchAccessKey,
  verifyAccessKey,
  type AccessKeyGrant,
} from '../../lib/access-keys';
import { keyMayCall, matchApiV1Route } from '../../lib/api-v1';
import { requestMetaFrom } from '../../lib/audit';
import { clientIp } from '../../lib/rate-limit';

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
 * expiry, login), then the key's own rate budget, then its scope
 * (lib/api-v1.ts: the route's area, read or write). Only a key that passes
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
): Promise<{ grant: AccessKeyGrant } | { response: Response }> {
  const ip = clientIp(req);
  const meta = () => ({ method: req.method, path, ...requestMetaFrom(req) });

  const budget = failedKeyBudget(ip, token);
  if (!budget.ok) return { response: tooMany(budget.retryAfterSec) };

  const check = await verifyAccessKey(token);
  if (!check.ok) {
    countFailedKey(ip, token);
    if (check.keyId) auditKeyRefusal({ keyId: check.keyId, reason: check.reason, ...meta() });
    return { response: unauthorized() };
  }
  const grant = check.grant;

  if (!isApiV1Path(path)) {
    auditKeyRefusal({ keyId: grant.id, reason: 'not-v1', ...meta() });
    return { response: unauthorized() };
  }

  const limit = rateLimitAccessKey(grant.id, 'v1');
  if (!limit.ok) return { response: tooMany(limit.retryAfterSec) };

  // The key's scope against the v1 table. A path that is not in the table
  // is a 404: it is not part of the API a key can call.
  const scope = keyMayCall(grant, matchApiV1Route(req.method, path));
  if (!scope.ok) {
    if (scope.reason === 'not-in-api') return { response: notFound() };
    auditKeyRefusal({ keyId: grant.id, reason: scope.reason, ...meta() });
    return { response: outOfScope(scope.reason) };
  }

  touchAccessKey(grant.id, ip);
  return { grant };
}

function unauthorized(): Response {
  return Response.json(
    { error: 'unauthorized' },
    { status: 401, headers: { 'Cache-Control': 'no-store' } },
  );
}

function notFound(): Response {
  return Response.json(
    { error: 'not found' },
    { status: 404, headers: { 'Cache-Control': 'no-store' } },
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
    { status: 403, headers: { 'Cache-Control': 'no-store' } },
  );
}

function tooMany(retryAfterSec: number): Response {
  return Response.json(
    { error: 'rate_limited' },
    {
      status: 429,
      headers: { 'Cache-Control': 'no-store', 'Retry-After': String(retryAfterSec) },
    },
  );
}
