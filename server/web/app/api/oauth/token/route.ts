/**
 * OAuth 2.1 token endpoint. Exchanges a PKCE-protected authorization code for an
 * access (+ refresh) token, and rotates refresh tokens. Public clients only
 * (token_endpoint_auth_method=none) — PKCE is the client proof. Standard
 * application/x-www-form-urlencoded request. Public endpoint; rate-limited later.
 *
 * Gated on the box's MCP switch like every other connector endpoint (access
 * matrix T10): while it is off, no code is exchanged and no refresh mints a
 * grant. Each grant made is on the audit trail (T11).
 */
import { NextResponse } from '@/server/http-compat';
import { isBusy, pgErrorCode } from '@mantle/db';
import {
  exchangeAuthCode,
  isRemoteMcpEnabled,
  refreshAccessToken,
  type TokenResponse,
} from '@/lib/mcp-oauth';
import { clientIpKey, rateLimit } from '@/lib/rate-limit';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';

function oauthError(error: string, description?: string, status = 400) {
  return NextResponse.json(
    { error, ...(description ? { error_description: description } : {}) },
    { status, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } },
  );
}

/**
 * A grant that met the login's OAuth lock busy (a lock timeout), or a slow
 * statement under it (a statement timeout), answers 503 with an OAuth error
 * body (RFC 6749 `temporarily_unavailable`), so the client retries rather
 * than dropping the connector (last check F2). Never the app's 409.
 */
async function whenNotBusy<T>(run: () => Promise<T>): Promise<T | Response> {
  try {
    return await run();
  } catch (err) {
    if (isBusy(err) || pgErrorCode(err) === '57014') {
      return oauthError('temporarily_unavailable', 'Try again in a moment.', 503);
    }
    throw err;
  }
}

function tokenOk(tokens: TokenResponse) {
  return NextResponse.json(tokens, {
    headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
  });
}

/** The grant on the trail, after its transaction committed. */
function auditGrant(
  req: Request,
  action: 'oauth.code_exchanged' | 'oauth.token_refreshed',
  res: { login: { id: string; email: string }; clientId: string },
): void {
  auditFireAndForget({
    actorId: res.login.id,
    actorEmail: res.login.email,
    action,
    method: 'POST',
    path: '/api/oauth/token',
    detail: { clientId: res.clientId },
    ...requestMetaFrom(req),
  });
}

export async function POST(req: Request) {
  const limit = rateLimit(`oauth:token:${clientIpKey(req)}`, { max: 30, windowMs: 60_000 });
  if (!limit.ok) return oauthError('rate_limited', undefined, 429);
  // The box's switch off: the connector is invisible, as on /api/mcp,
  // /authorize and /register. A refresh must not keep a grant alive.
  if (!(await isRemoteMcpEnabled())) return oauthError('not_found', undefined, 404);

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
      return oauthError(
        'invalid_request',
        'code, redirect_uri, client_id, code_verifier are required',
      );
    }
    const res = await whenNotBusy(() =>
      exchangeAuthCode({ code, redirectUri, clientId, codeVerifier }),
    );
    if (res instanceof Response) return res;
    if (!res.ok) return oauthError(res.error);
    auditGrant(req, 'oauth.code_exchanged', res);
    return tokenOk(res.tokens);
  }

  if (grantType === 'refresh_token') {
    const refreshToken = get('refresh_token');
    const clientId = get('client_id');
    if (!refreshToken || !clientId) {
      return oauthError('invalid_request', 'refresh_token and client_id are required');
    }
    const res = await whenNotBusy(() => refreshAccessToken({ refreshToken, clientId }));
    if (res instanceof Response) return res;
    if (!res.ok) return oauthError(res.error);
    auditGrant(req, 'oauth.token_refreshed', res);
    return tokenOk(res.tokens);
  }

  return oauthError('unsupported_grant_type');
}
