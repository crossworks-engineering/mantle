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
 * valid bearer resolves to a LOGIN (lib/mcp-auth.ts, MCP as a login): an
 * admin gets the owner's tools as before; a member or client gets their own
 * role's tools at their own level; a peer token acts as the login it is
 * bound to. A second rate limit holds each login to its own budget.
 *
 * `runtime = 'nodejs'`: the tool handlers use node-only deps (pg, drizzle,
 * file/storage). The adapter runs the SDK's Streamable HTTP transport
 * statelessly (no Redis / session store).
 */
import { createMcpHandler } from 'mcp-handler';
import { mcpInstructionsFor, prepareCallerTools, registerPreparedTools } from '@mantle/mcp-core';
import { isRemoteMcpEnabled, wwwAuthenticateHeader } from '@/lib/mcp-oauth';
import { resolveMcpCaller } from '@/lib/mcp-auth';
import { JSON_BODY_CEILING_BYTES } from '@/lib/body-limit';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import { rateLimitAccessKey } from '@/lib/access-keys';

// Generous — the MCP client makes one HTTP request per tool call, so this must
// clear normal bursty tool traffic while still capping a flood.
const RATE = { max: 300, windowMs: 60_000 };
/** Per login, so one login's client cannot use up the box's budget. */
const LOGIN_RATE = { max: 300, windowMs: 60_000 };

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

  const caller = await resolveMcpCaller(req);
  if (!caller) return unauthorized();
  // Each peer and each API key has its own budget, so a busy peer or script
  // cannot starve the owner's own connector.
  const perLogin = caller.keyId
    ? rateLimitAccessKey(caller.keyId, 'mcp')
    : rateLimit(`mcp-login:${caller.peerId ?? caller.loginId}`, LOGIN_RATE);
  if (!perLogin.ok) {
    return new Response(JSON.stringify({ error: 'rate_limited' }), {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'Retry-After': String(perLogin.retryAfterSec),
      },
    });
  }
  // A member or client never sends a whole owner document: their bodies are
  // held to the plain JSON ceiling (the owner's 128 MB is for file_upload).
  if (caller.role !== 'admin') {
    const declared = Number(req.headers.get('content-length')) || 0;
    if (declared > JSON_BODY_CEILING_BYTES) {
      return new Response(
        JSON.stringify({ error: 'request body too large', reason: 'body-too-large' }),
        { status: 413, headers: { 'content-type': 'application/json' } },
      );
    }
  }
  // A member's or client's tools are resolved from their responder's groups
  // here, before the adapter registers synchronously.
  const prepared = await prepareCallerTools(caller);
  // No tools at all (the role's responder is closed, or missing): say so,
  // rather than serve an MCP server with nothing on it.
  if (prepared.kind === 'login' && prepared.rows.length === 0) {
    return new Response(
      JSON.stringify({
        error: 'no_tools',
        message: 'This login has no MCP tools on this brain. Ask an admin of this brain.',
      }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    );
  }

  const mcpHandler = createMcpHandler(
    // Network transport: `run_terminal` stays off unless the operator sets
    // MANTLE_MCP_TERMINAL=1 on the box (see packages/mcp-core/src/build-server.ts).
    (server) => registerPreparedTools(server, prepared, { transport: 'http' }),
    // Recall's tier-1 hook rides the owner's server instructions, the one
    // surface a client auto-loads besides the tool list (docs/recall.md); a
    // login is told who it acts as.
    { instructions: mcpInstructionsFor(caller) },
    { basePath: '/api' },
  );
  return mcpHandler(req);
}

export { handler as GET, handler as POST, handler as DELETE };
