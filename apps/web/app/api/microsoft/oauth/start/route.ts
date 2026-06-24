import { NextResponse } from 'next/server';
import { buildAuthorizeUrl, createPkce, createState, isMicrosoftConfigured } from '@mantle/microsoft';
import { requireOwner } from '@/lib/auth';

/**
 * Kick off the delegated OAuth flow: mint a PKCE pair + CSRF state, stash the
 * verifier/state in short-lived httpOnly cookies, and redirect the browser to
 * Microsoft for sign-in + consent. The callback completes the exchange.
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

export async function GET() {
  await requireOwner();

  if (!isMicrosoftConfigured()) {
    return NextResponse.redirect(
      new URL('/settings/microsoft?error=not_configured', process.env.NEXT_PUBLIC_APP_URL),
    );
  }

  const { verifier, challenge } = createPkce();
  const state = createState();
  const res = NextResponse.redirect(buildAuthorizeUrl({ state, challenge }));
  res.cookies.set('ms_oauth_verifier', verifier, COOKIE_OPTS);
  res.cookies.set('ms_oauth_state', state, COOKIE_OPTS);
  return res;
}
