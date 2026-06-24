import { createHash } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { exchangeCode, fetchMe, resolveOAuthConfig, upsertAccountFromTokens } from '@mantle/microsoft';
import { requireOwner } from '@/lib/auth';

/**
 * OAuth callback: validate state against the cookie, exchange the code (+ PKCE
 * verifier) for tokens, identify the account via Graph /me, and persist a
 * sealed, self-refreshing account row. Always redirects back to the settings
 * page with a `connected` or `error` query param. The PKCE/state cookies are
 * cleared on the way out so they can't be replayed.
 */
export const dynamic = 'force-dynamic';

/** Stable ltree root for a connected Microsoft account's ingested content.
 *  Distinct `microsoft.` namespace so it never collides with email's `inbox.`.
 *  4-hex suffix keeps two same-local UPNs on different tenants apart. */
function msBranchPath(upn: string): string {
  const [local, domain] = upn.toLowerCase().split('@');
  const clean = (local ?? '').replace(/[^a-z0-9]/g, '_').replace(/^_+|_+$/g, '') || 'account';
  const hash = createHash('sha256').update(domain ?? '').digest('hex').slice(0, 4);
  return `microsoft.${clean}_${hash}`;
}

function settingsRedirect(req: NextRequest, params: Record<string, string>): NextResponse {
  const url = new URL('/settings/microsoft', req.url);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = NextResponse.redirect(url);
  // One-shot cookies — clear regardless of outcome.
  res.cookies.delete('ms_oauth_verifier');
  res.cookies.delete('ms_oauth_state');
  return res;
}

export async function GET(req: NextRequest) {
  const user = await requireOwner();

  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');

  // User declined consent, or Azure returned an error.
  if (oauthError) {
    const desc = url.searchParams.get('error_description') ?? oauthError;
    return settingsRedirect(req, { error: desc.slice(0, 200) });
  }

  const expectedState = req.cookies.get('ms_oauth_state')?.value;
  const verifier = req.cookies.get('ms_oauth_verifier')?.value;
  if (!code || !state || !expectedState || state !== expectedState || !verifier) {
    return settingsRedirect(req, { error: 'Invalid or expired sign-in attempt. Please try again.' });
  }

  const cfg = await resolveOAuthConfig(user.id);
  if (!cfg) return settingsRedirect(req, { error: 'not_configured' });

  try {
    const tokens = await exchangeCode(cfg, { code, verifier });
    const me = await fetchMe(tokens.accessToken);
    await upsertAccountFromTokens({
      userId: user.id,
      upn: me.upn,
      displayName: me.displayName,
      tenantId: me.tenantId,
      branchPath: msBranchPath(me.upn),
      tokens,
    });
    return settingsRedirect(req, { connected: me.upn });
  } catch (err) {
    return settingsRedirect(req, { error: (err as Error).message.slice(0, 200) });
  }
}
