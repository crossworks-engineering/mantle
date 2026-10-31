import { NextResponse } from '@/server/http-compat';
import { publicLoginItself, unauthorizedRefusal } from '@/lib/auth';
import { publicBaseUrl } from '@mantle/content';
import { issuePairCode, pairPayloadUrl, PAIR_CODE_TTL_SEC } from '@/lib/pair-code';
import { CACHE_CONTROL } from '@/lib/cache-control';
import { ownOidcCookieEnd } from '@/lib/auth/own-device';
import type { OidcRefusal } from '@mantle/client-types';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'self',
    public: true,
    caller: 'publicLogin',
    item: { none: "the login's own things, not an item" },
    limits: { rateLimit: ['authPairIssue'] },
  },
});

/**
 * POST /api/auth/pair — mint a one-time pairing code for "Sign in on your
 * phone". A signed-in session required (this is a login surface, so
 * `/api/auth` being a public prefix does not excuse it: the gate is here):
 * an admin or a member (only the person pairs their
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
export async function POST(req: Request) {
  // With the generic api.write row an Admin user's write writes (and any
  // login's with a key: the gate refuses a key here). A public row: the
  // login the pipeline answers at this read.
  // The read takes the row's per-login limit (lib/route-limits.ts:
  // authPairIssue) and throws the one 429 over it.
  const login = await publicLoginItself({ audit: true });
  if (!login) return unauthorizedRefusal();
  // A session made by company sign-in lasts MANTLE_OIDC_SESSION_HOURS; a
  // phone paired from it would hold a refreshable bearer that outlives it
  // (and a provider block). Refused until the phone signs in with company
  // sign-in itself (docs/oidc-sign-in.md, "Not in this milestone").
  if (login.source === 'web' && ownOidcCookieEnd(req) !== null) {
    const body: OidcRefusal = {
      error: 'A company sign-in session cannot pair a phone yet. Sign in on the phone itself.',
      code: 'sso-session',
    };
    return NextResponse.json(body, { status: 403 });
  }

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
