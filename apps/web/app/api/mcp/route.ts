/**
 * Remote MCP endpoint — the Streamable-HTTP transport for the Mantle tool
 * surface, served via the `mcp-handler` Next adapter. Registers the SAME tools
 * the stdio server exposes, from the shared builder (`@mantle/mcp-core`), so the
 * two transports never drift.
 *
 * Gating, in order: (1) per-IP rate limit, so a public surface can't be flooded;
 * (2) the box-level enable flag — when the owner hasn't opted in, the endpoint
 * 404s and is effectively invisible; (3) OAuth — an absent/invalid access token
 * gets a 401 carrying `WWW-Authenticate: Bearer resource_metadata=…` (RFC 9728)
 * so a fresh claude.ai connector discovers the AS and runs sign-in + consent. A
 * valid token resolves to its owner, and the server is built scoped to THAT
 * owner.
 *
 * `runtime = 'nodejs'`: the tool handlers use node-only deps (pg, drizzle,
 * file/storage). The adapter runs the SDK's Streamable HTTP transport
 * statelessly (no Redis / session store).
 */
import { createMcpHandler } from 'mcp-handler';
import { registerMantleTools } from '@mantle/mcp-core';
import { isRemoteMcpEnabled, ownerFromBearer, wwwAuthenticateHeader } from '@/lib/mcp-oauth';
import { clientIp, rateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Generous — the MCP client makes one HTTP request per tool call, so this must
// clear normal bursty tool traffic while still capping a flood.
const RATE = { max: 300, windowMs: 60_000 };

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401,
    headers: {
      'content-type': 'application/json',
      'WWW-Authenticate': wwwAuthenticateHeader(),
    },
  });
}

function notFound(): Response {
  return new Response(JSON.stringify({ error: 'not_found' }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });
}

async function handler(req: Request): Promise<Response> {
  const limit = rateLimit(`mcp:${clientIp(req)}`, RATE);
  if (!limit.ok) {
    return new Response(JSON.stringify({ error: 'rate_limited' }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'Retry-After': String(limit.retryAfterSec) },
    });
  }

  if (!(await isRemoteMcpEnabled())) return notFound();

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
