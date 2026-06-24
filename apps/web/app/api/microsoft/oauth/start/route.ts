import { NextResponse, type NextRequest } from 'next/server';
import { buildAuthorizeUrl, createPkce, createState, resolveOAuthConfig } from '@mantle/microsoft';
import { requireOwner } from '@/lib/auth';

/**
 * Kick off the delegated OAuth flow: resolve this brain's Azure app config
 * (UI row → MS_* env), mint a PKCE pair + CSRF state, stash the verifier/state
 * in short-lived httpOnly cookies, and redirect the browser to Microsoft for
 * sign-in + consent. The callback completes the exchange.
 *
 * Owner-gated — only the brain's owner can connect a Microsoft account.
 */
export const dynamic = 'force-dynamic';

const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/api/microsoft/oauth',
  maxAge: 600, // 10 min — the user just has to finish signing in
};

export async function GET(req: NextRequest) {
  const user = await requireOwner();

  const cfg = await resolveOAuthConfig(user.id);
  if (!cfg) {
    return NextResponse.redirect(new URL('/settings/microsoft?error=not_configured', req.url));
  }

  const { verifier, challenge } = createPkce();
  const state = createState();
  const res = NextResponse.redirect(buildAuthorizeUrl(cfg, { state, challenge }));
  res.cookies.set('ms_oauth_verifier', verifier, COOKIE_OPTS);
  res.cookies.set('ms_oauth_state', state, COOKIE_OPTS);
  return res;
}
