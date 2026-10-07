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
 * it is no credential: 401, whatever cookie rides along.
 *
 * Order: the caller's failed-try budget, then the key (shape, hash in
 * constant time, revoke, expiry, login), then the key's own rate budget,
 * then its scope (lib/api-v1.ts: the route's area, read or write).
 * A bad key never learns which check failed: 401 `unauthorized` for every
 * one, so a caller learns nothing about a key it does not hold. A good key
 * out of its scope gets 403 with the reason (`key-area`, `key-read-only`).
 */
export async function gateAccessKey(
  req: Request,
  path: string,
  token: string,
): Promise<{ grant: AccessKeyGrant } | { response: Response }> {
  if (!isApiV1Path(path)) return { response: unauthorized() };

  const ip = clientIp(req);
  const budget = failedKeyBudget(ip);
  if (!budget.ok) return { response: tooMany(budget.retryAfterSec) };

  const check = await verifyAccessKey(token);
  if (!check.ok) {
    countFailedKey(ip);
    if (check.keyId) {
      auditKeyRefusal({
        keyId: check.keyId,
        reason: check.reason,
        method: req.method,
        path,
        ...requestMetaFrom(req),
      });
    }
    return { response: unauthorized() };
  }

  const limit = rateLimitAccessKey(check.grant.id, 'v1');
  if (!limit.ok) return { response: tooMany(limit.retryAfterSec) };

  // The key's scope against the v1 table (lib/api-v1.ts). A path that is
  // not in the table is a 404: it is not part of the API a key can call.
  const scope = keyMayCall(check.grant, matchApiV1Route(req.method, path));
  if (!scope.ok) {
    if (scope.reason === 'not-in-api') return { response: notFound() };
    auditKeyRefusal({
      keyId: check.grant.id,
      reason: scope.reason,
      method: req.method,
      path,
      ...requestMetaFrom(req),
    });
    return { response: outOfScope(scope.reason) };
  }

  touchAccessKey(check.grant.id, ip);
  return { grant: check.grant };
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

function unauthorized(): Response {
  return Response.json(
    { error: 'unauthorized' },
    { status: 401, headers: { 'Cache-Control': 'no-store' } },
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
