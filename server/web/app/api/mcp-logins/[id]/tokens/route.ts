/**
 * POST /api/mcp-logins/:id/tokens : RETIRED (Jason, 2026-10-07). An admin
 * no longer makes a static MCP token (`mtlmcpk_`) for a member or client:
 * nobody makes a credential that acts as another login. Each login makes
 * its own API key in Settings > API access (POST /api/access-keys), and
 * those keys work on /api/mcp.
 *
 * Tokens made before keep working until revoked (lib/mcp-auth.ts), and
 * GET /api/mcp-logins and DELETE .../tokens/:tokenId still list and revoke
 * them. This route answers 410 to any caller an admin gate lets through.
 */
import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';

export async function POST() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  return NextResponse.json(
    {
      error: 'gone',
      reason: 'mcp-login-tokens-retired',
      message:
        'Admins no longer make MCP tokens for other logins. Each member or client makes their own API key in Settings > API access.',
    },
    { status: 410 },
  );
}
