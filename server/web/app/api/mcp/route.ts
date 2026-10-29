/**
 * Remote MCP endpoint — the Streamable-HTTP transport for the Mantle tool
 * surface, served by the SDK's own web-standard `createMcpHandler`
 * (@modelcontextprotocol/server). Registers the SAME tools
 * the stdio server exposes, from the shared builder (`@mantle/mcp-core`), so the
 * two transports never drift.
 *
 * Gating, in order: (1) per-IP rate limit, so a public surface can't be flooded
 * (the row's, taken by the gate: lib/route-limits.ts mcp);
 * (2) the box-level enable flag — when the owner hasn't opted in, the endpoint
 * 404s and is effectively invisible; (3) OAuth — an absent/invalid access token
 * gets a 401 carrying `WWW-Authenticate: Bearer resource_metadata=…` (RFC 9728)
 * so a fresh claude.ai connector discovers the AS and runs sign-in + consent. A
 * valid bearer resolves to a LOGIN (lib/mcp-auth.ts, MCP as a login): every
 * login gets the one owner surface, each tool listed and called through the
 * one gate in that login's workspaces (@mantle/mcp-core gated-tools.ts
 * and login-surface.ts); a key or a peer
 * token acts as the login it is bound to and only narrows it. A
 * second rate limit holds each login to its own
 * budget.
 *
 * `runtime = 'nodejs'`: the tool handlers use node-only deps (pg, drizzle,
 * file/storage). The handler serves 2025-era clients statelessly (a fresh
 * server per request, GET and DELETE answered 405, no Redis / session store),
 * and 2026-07-28 clients per request on the same endpoint, except for
 * `subscriptions/listen` (405, lib/mcp-http.ts).
 */
import {
  mcpInstructionsFor,
  preparedLists,
  prepareCallerTools,
  registerPreparedTools,
} from '@mantle/mcp-core';
import { isRemoteMcpEnabled, wwwAuthenticateHeader } from '@/lib/mcp-oauth';
import { auditMcpKeyCall, resolveMcpCaller } from '@/lib/mcp-auth';
import { isSubscriptionListen, mcpHttpHandler } from '@/lib/mcp-http';
import { rateLimit } from '@/lib/rate-limit';
import { rateLimitedResponse } from '@/lib/route-limits';
import { rateLimitAccessKey } from '@/lib/access-keys';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'public', limits: { rateLimit: ['mcp'] } },
  POST: {
    class: 'public',
    item: { none: 'a public route: it judges its own credential' },
    limits: { rateLimit: ['mcp'] },
  },
  DELETE: {
    class: 'public',
    item: { none: 'a public route: it judges its own credential' },
    limits: { rateLimit: ['mcp'] },
  },
});

/** Per login, so one login's client cannot use up the box's budget. Taken
 *  here, once the bearer is resolved (the caller is this route's own
 *  check): named in eslint-rules/route-plumbing.mjs RATE_LIMIT_ALLOW. The
 *  per-address limit before it is the row's (lib/route-limits.ts mcp). */
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
  // The gate took the row's per-address limit (keyed on the /64 for IPv6:
  // rotating addresses inside one /64 buys no fresh budget).
  if (!(await isRemoteMcpEnabled())) return notFound();

  // An endless SSE stream per request, uncapped (lib/mcp-http.ts): refused.
  if (isSubscriptionListen(req)) {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { 'content-type': 'application/json' },
    });
  }

  const caller = await resolveMcpCaller(req);
  if (!caller) return unauthorized();
  // Each peer and each API key has its own budget, so a busy peer or script
  // cannot starve the owner's own connector.
  const perLogin = caller.keyId
    ? rateLimitAccessKey({ id: caller.keyId, loginId: caller.loginId }, 'mcp')
    : rateLimit(`mcp-login:${caller.peerId ?? caller.loginId}`, LOGIN_RATE);
  if (!perLogin.ok) return rateLimitedResponse(perLogin.retryAfterSec, 'machine');
  // What the login's scope may list, its private workspace and its
  // connector tools, resolved here, so the server factory below registers
  // synchronously.
  const prepared = await prepareCallerTools(caller);
  // A write tool an API key calls leaves an audit row (lib/mcp-auth.ts),
  // once the call is one this caller was given (the one gate lists it).
  if (caller.keyId) await auditMcpKeyCall(req, caller, (slug) => preparedLists(prepared, slug));

  // Recall's tier-1 hook rides the owner's server instructions, the one
  // surface a client auto-loads besides the tool list (docs/recall.md); a
  // login is told who it acts as, and a login in no workspace why it lists
  // no tools. Network transport: `run_terminal` stays off unless the
  // operator sets MANTLE_MCP_TERMINAL=1 on the box (see
  // packages/mcp-core/src/build-server.ts).
  const mcpHandler = mcpHttpHandler(
    (server) => registerPreparedTools(server, prepared, { transport: 'http' }),
    mcpInstructionsFor(caller, prepared),
  );
  return mcpHandler.fetch(req);
}

export { handler as GET, handler as POST, handler as DELETE };
