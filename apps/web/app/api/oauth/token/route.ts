/**
 * OAuth 2.1 token endpoint. Exchanges a PKCE-protected authorization code for an
 * access (+ refresh) token, and rotates refresh tokens. Public clients only
 * (token_endpoint_auth_method=none) — PKCE is the client proof. Standard
 * application/x-www-form-urlencoded request. Public endpoint; rate-limited later.
 */
import { NextResponse } from 'next/server';
import { exchangeAuthCode, refreshAccessToken, type TokenResponse } from '@/lib/mcp-oauth';
import { clientIp, rateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function oauthError(error: string, description?: string, status = 400) {
  return NextResponse.json(
    { error, ...(description ? { error_description: description } : {}) },
    { status, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } },
  );
}

function tokenOk(tokens: TokenResponse) {
  return NextResponse.json(tokens, {
    headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
  });
}

export async function POST(req: Request) {
  const limit = rateLimit(`oauth:token:${clientIp(req)}`, { max: 30, windowMs: 60_000 });
  if (!limit.ok) return oauthError('rate_limited', undefined, 429);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return oauthError('invalid_request', 'expected application/x-www-form-urlencoded');
  }
  const get = (k: string) => {
    const v = form.get(k);
    return typeof v === 'string' ? v : undefined;
  };

  const grantType = get('grant_type');

  if (grantType === 'authorization_code') {
    const code = get('code');
    const redirectUri = get('redirect_uri');
    const clientId = get('client_id');
    const codeVerifier = get('code_verifier');
    if (!code || !redirectUri || !clientId || !codeVerifier) {
      return oauthError('invalid_request', 'code, redirect_uri, client_id, code_verifier are required');
    }
    const res = await exchangeAuthCode({ code, redirectUri, clientId, codeVerifier });
    return res.ok ? tokenOk(res.tokens) : oauthError(res.error);
  }

  if (grantType === 'refresh_token') {
    const refreshToken = get('refresh_token');
    const clientId = get('client_id');
    if (!refreshToken || !clientId) {
      return oauthError('invalid_request', 'refresh_token and client_id are required');
    }
    const res = await refreshAccessToken({ refreshToken, clientId });
    return res.ok ? tokenOk(res.tokens) : oauthError(res.error);
  }

  return oauthError('unsupported_grant_type');
}
