/**
 * RFC 8414 — OAuth 2.0 Authorization Server Metadata. The connector fetches this
 * to discover the register/authorize/token endpoints. Public (no auth); listed
 * in PUBLIC_PATHS so the session gate lets it through.
 */
import { NextResponse } from '@/server/http-compat';
import { issuerUrl } from '@/lib/mcp-oauth';
import { CACHE_CONTROL } from '@/lib/cache-control';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'public' },
});

export async function GET() {
  const base = issuerUrl();
  return NextResponse.json(
    {
      issuer: base,
      authorization_endpoint: `${base}/api/oauth/authorize`,
      token_endpoint: `${base}/api/oauth/token`,
      registration_endpoint: `${base}/api/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp'],
    },
    { headers: { 'Cache-Control': CACHE_CONTROL.none } },
  );
}
