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
import { requestMetaFrom } from '../../lib/audit';
import { clientIp } from '../../lib/rate-limit';

/**
 * The gate's answer to an `mtlk_` bearer (inbound API keys, plan page
 * 1e62e204). A key is accepted on /api/v1/* only (/api/mcp is a public
 * path and checks keys itself, lib/mcp-auth.ts). Anywhere else under /api
 * it is no credential: 401, whatever cookie rides along.
 *
 * Order: the caller's failed-try budget, then the key (shape, hash in
 * constant time, revoke, expiry, login), then the key's own rate budget.
 * A refusal never says which check failed: 401 `unauthorized` for every
 * bad key, so a caller learns nothing about a key it does not hold.
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

  touchAccessKey(check.grant.id, ip);
  return { grant: check.grant };
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
