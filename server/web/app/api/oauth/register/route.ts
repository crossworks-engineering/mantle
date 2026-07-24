/**
 * RFC 7591 — OAuth 2.0 Dynamic Client Registration. The paste-the-URL connector
 * flow needs this: claude.ai POSTs its redirect URIs and gets back a client_id.
 * Public clients only (PKCE, no secret issued). Public endpoint; rate-limited in
 * the route layer (Phase 4).
 */
import { NextResponse } from '@/server/http-compat';
import { isAllowedRedirectUri, isRemoteMcpEnabled, registerClient } from '@/lib/mcp-oauth';
import { clientIp, rateLimit } from '@/lib/rate-limit';


function error(status: number, error: string, description?: string) {
  return NextResponse.json(
    { error, ...(description ? { error_description: description } : {}) },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function POST(req: Request) {
  const limit = rateLimit(`oauth:register:${clientIp(req)}`, { max: 10, windowMs: 60_000 });
  if (!limit.ok) return error(429, 'rate_limited');
  // Don't let clients register against a box that hasn't opted in.
  if (!(await isRemoteMcpEnabled())) return error(404, 'not_found');

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return error(400, 'invalid_client_metadata', 'body must be JSON');
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const redirectUris = b.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return error(400, 'invalid_redirect_uri', 'redirect_uris is required');
  }
  if (!redirectUris.every((u) => typeof u === 'string' && isAllowedRedirectUri(u))) {
    return error(
      400,
      'invalid_redirect_uri',
      'each redirect_uri must be https (or http on loopback)',
    );
  }

  const clientName = typeof b.client_name === 'string' ? b.client_name : null;
  const client = await registerClient({ clientName, redirectUris: redirectUris as string[] });

  return NextResponse.json(
    {
      client_id: client.id,
      client_name: client.clientName ?? undefined,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
    },
    { status: 201, headers: { 'Cache-Control': 'no-store' } },
  );
}
