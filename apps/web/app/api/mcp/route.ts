/**
 * Remote MCP endpoint — the Streamable-HTTP transport for the Mantle tool
 * surface, served via the `mcp-handler` Next adapter. Registers the SAME tools
 * the stdio server exposes, from the shared builder (`@mantle/mcp-core`), so the
 * two transports never drift.
 *
 * AUTH IS A PLACEHOLDER (Phase 1): gated by a hardcoded bearer and scoped to the
 * single local owner via `resolveSingleOwnerId`. Phase 2 replaces both with
 * OAuth — the bearer becomes an access token that resolves to its owner, and
 * `registerMantleTools(server, ownerId)` is called with THAT owner. The session
 * middleware already lets `/api/mcp` through (PUBLIC_PATHS) so this
 * self-authenticates.
 *
 * `runtime = 'nodejs'`: the tool handlers use node-only deps (pg, drizzle,
 * file/storage). The adapter runs the SDK's Streamable HTTP transport
 * statelessly (no Redis / session store needed).
 */
import { createMcpHandler } from 'mcp-handler';
import { resolveSingleOwnerId } from '@mantle/db';
import { registerMantleTools } from '@mantle/mcp-core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// PHASE 1 PLACEHOLDER — replaced by an OAuth access token in Phase 2.
const PLACEHOLDER_TOKEN = 'spike-secret';

function authed(req: Request): boolean {
  return req.headers.get('authorization') === `Bearer ${PLACEHOLDER_TOKEN}`;
}

async function handler(req: Request): Promise<Response> {
  if (!authed(req)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  // PHASE 2: resolve the owner from the validated OAuth bearer instead.
  const ownerId = await resolveSingleOwnerId();
  if (!ownerId) {
    return new Response(JSON.stringify({ error: 'no account' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }

  const mcpHandler = createMcpHandler(
    (server) => registerMantleTools(server, ownerId),
    {},
    { basePath: '/api' },
  );
  return mcpHandler(req);
}

export { handler as GET, handler as POST, handler as DELETE };
