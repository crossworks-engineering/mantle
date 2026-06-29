/**
 * Remote MCP endpoint — the Streamable-HTTP transport for the Mantle tool
 * surface, served via the `mcp-handler` Next adapter. Registers the SAME tools
 * the stdio server exposes, from the shared builder (`@mantle/mcp-core`), so the
 * two transports never drift.
 *
 * Auth: an OAuth 2.1 access token (see apps/web/lib/mcp-oauth.ts). An absent or
 * invalid token gets a 401 carrying `WWW-Authenticate: Bearer resource_metadata=…`
 * (RFC 9728) so a fresh claude.ai connector discovers the authorization server
 * and runs the sign-in + consent flow. A valid token resolves to its owner, and
 * the server is built scoped to THAT owner.
 *
 * `runtime = 'nodejs'`: the tool handlers use node-only deps (pg, drizzle,
 * file/storage). The adapter runs the SDK's Streamable HTTP transport
 * statelessly (no Redis / session store).
 */
import { createMcpHandler } from 'mcp-handler';
import { registerMantleTools } from '@mantle/mcp-core';
import { ownerFromBearer, wwwAuthenticateHeader } from '@/lib/mcp-oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401,
    headers: {
      'content-type': 'application/json',
      'WWW-Authenticate': wwwAuthenticateHeader(),
    },
  });
}

async function handler(req: Request): Promise<Response> {
  const ownerId = await ownerFromBearer(req);
  if (!ownerId) return unauthorized();

  const mcpHandler = createMcpHandler(
    (server) => registerMantleTools(server, ownerId),
    {},
    { basePath: '/api' },
  );
  return mcpHandler(req);
}

export { handler as GET, handler as POST, handler as DELETE };
