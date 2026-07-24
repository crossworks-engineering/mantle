/**
 * RFC 9728 — OAuth 2.0 Protected Resource Metadata. The `/api/mcp` 401 points
 * here via WWW-Authenticate; the connector reads it to learn which authorization
 * server protects the resource, then runs discovery against that AS. Public.
 */
import { NextResponse } from '@/server/http-compat';
import { issuerUrl, mcpResourceUrl } from '@/lib/mcp-oauth';

export async function GET() {
  return NextResponse.json(
    {
      resource: mcpResourceUrl(),
      authorization_servers: [issuerUrl()],
      scopes_supported: ['mcp'],
      bearer_methods_supported: ['header'],
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
