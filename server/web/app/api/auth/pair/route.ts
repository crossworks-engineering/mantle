import { NextResponse } from '@/server/http-compat';
import { publicLoginCaller, unauthorizedRefusal } from '@/lib/auth';
import { publicBaseUrl } from '@mantle/content';
import { issuePairCode, pairPayloadUrl, PAIR_CODE_TTL_SEC } from '@/lib/pair-code';
import { CACHE_CONTROL } from '@/lib/cache-control';

/**
 * POST /api/auth/pair — mint a one-time pairing code for "Sign in on your
 * phone". A signed-in session required (this is a login surface, so
 * `/api/auth` being a public prefix does not excuse it: the gate is here):
 * an admin, or since workspaces W7e a member (only the person pairs their
 * own phone; the claim then needs the phone build that serves every login,
 * else 426). A client signs in on its phone with its emailed code. The code is
 * bound to the login that asked, expires in {@link PAIR_CODE_TTL_SEC}, and
 * is claimed once at /api/auth/pair/claim. Rate-limited per login so a page
 * cannot mint thousands.
 *
 * Returns `{ id, code, url, expiresAt, ttlSeconds }`: `url` is the exact
 * string to encode as the QR (`<brain>/pair#v=1&code=…`); `id` is what
 * GET /api/auth/pair/[id] polls.
 */
export async function POST() {
  // With the generic api.write row an Admin user's write writes (and any
  // login's with a key: the gate refuses a key here). A public row: the
  // login the pipeline answers at this read (A4 hand batch B).
  // The read takes the row's per-login limit (lib/route-limits.ts:
  // authPairIssue) and throws the one 429 over it.
  const login = await publicLoginCaller({ audit: true });
  if (!login) return unauthorizedRefusal();

  const issued = await issuePairCode(login.loginId);
  return NextResponse.json(
    {
      id: issued.id,
      code: issued.code,
      url: pairPayloadUrl(publicBaseUrl(), issued.code),
      expiresAt: issued.expiresAt.toISOString(),
      ttlSeconds: PAIR_CODE_TTL_SEC,
    },
    { headers: { 'Cache-Control': CACHE_CONTROL.none } },
  );
}
