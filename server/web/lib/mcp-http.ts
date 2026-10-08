/**
 * The SDK half of the remote MCP endpoint (app/api/mcp/route.ts): the
 * per-request handler, and the one 2026-07-28 method the endpoint refuses.
 *
 * The route builds a handler per request (the caller's tools are resolved
 * per request), so nothing here may hold a connection open past its request.
 * `subscriptions/listen` would: it is an SSE stream with no end, and the
 * SDK's cap on open listens is per handler, so per request here, which is no
 * cap at all. Two locks keep it shut:
 * - the server says `tools.listChanged: false` (true: within one request the
 *   tool list never changes), so there is nothing to listen for;
 * - the route answers 405 to a listen before any work (`isSubscriptionListen`).
 */
import { createMcpHandler, McpServer, type McpHttpHandler } from '@modelcontextprotocol/server';
import { errorMessage } from '@mantle/std';
import { OWNER_DOCUMENT_CEILING_BYTES } from '@/lib/body-limit';

/** Same name and version as the stdio entry (packages/mcp-core build-server). */
const SERVER_INFO = { name: 'mantle', version: '0.0.1' };

/**
 * Whether `req` opens a 2026-07-28 `subscriptions/listen` stream. Read from
 * the `Mcp-Method` header, so the body is not read twice: the SDK requires
 * that header on every modern request and refuses one whose header and body
 * disagree (SEP-2243), so a listen cannot hide behind a missing or wrong one.
 */
export function isSubscriptionListen(req: Request): boolean {
  return req.headers.get('mcp-method')?.trim().toLowerCase() === 'subscriptions/listen';
}

/** An SDK failure as one log line: name and message, with quoted text cut
 *  (a JSON parse error quotes the body it failed on). Never the request. */
function logMcpError(err: Error): void {
  const message = errorMessage(err)
    .replace(/"[^"]*"/g, '"…"')
    .slice(0, 300);
  console.error('[mcp]', `${err.name}: ${message}`);
}

/** The handler for one request: a fresh server, `register` fills it. */
export function mcpHttpHandler(
  register: (server: McpServer) => void,
  instructions: string,
): McpHttpHandler {
  return createMcpHandler(
    () => {
      const server = new McpServer(SERVER_INFO, {
        instructions,
        capabilities: { tools: { listChanged: false } },
      });
      register(server);
      return server;
    },
    {
      // The SDK reads the body itself and caps it at 4 MiB by default. The
      // ceiling here is the one bodyCeilingFor('/api/mcp') already holds the
      // route to (a member's or client's body is capped lower in the route):
      // an owner's file_upload carries the whole file as base64.
      maxRequestBodySize: OWNER_DOCUMENT_CEILING_BYTES,
      onerror: logMcpError,
    },
  );
}
