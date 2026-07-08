import { NextResponse, type NextRequest } from 'next/server';
import { buildAuthorizeUrl, createPkce, createState, resolveOAuthConfig } from '@mantle/microsoft';
import { getOwnerOr401 } from '@/lib/auth';
import { requestOrigin, secureCookies } from '@/lib/auth-constants';

/**
 * Kick off the delegated OAuth flow: resolve this brain's Azure app config
 * (UI row → MS_* env), mint a PKCE pair + CSRF state, stash the verifier/state
 * in short-lived httpOnly cookies, and redirect the browser to Microsoft for
 * sign-in + consent. The callback completes the exchange.
 *
 * Owner-gated — only the brain's owner can connect a Microsoft account.
 */
export const dynamic = 'force-dynamic';

const cookieOpts = (req: NextRequest) => ({
  httpOnly: true,
  secure: secureCookies(req),
  sameSite: 'lax' as const,
  path: '/api/microsoft/oauth',
  maxAge: 600, // 10 min — the user just has to finish signing in
});

export async function GET(req: NextRequest) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;

  const cfg = await resolveOAuthConfig(user.id);
  if (!cfg) {
    return NextResponse.redirect(new URL('/settings/microsoft?error=not_configured', requestOrigin(req)));
  }

  const { verifier, challenge } = createPkce();
  const state = createState();
  const res = NextResponse.redirect(buildAuthorizeUrl(cfg, { state, challenge }));
  const opts = cookieOpts(req);
  res.cookies.set('ms_oauth_verifier', verifier, opts);
  res.cookies.set('ms_oauth_state', state, opts);
  return res;
}
