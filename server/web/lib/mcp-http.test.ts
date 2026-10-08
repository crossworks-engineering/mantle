/**
 * The remote MCP endpoint's SDK half (lib/mcp-http.ts), driven in-process by
 * real SDK clients over the handler's fetch.
 *
 * The case that matters is `subscriptions/listen`: a 2026-07-28 stream with no
 * end, uncapped because the route builds a handler per request. The route
 * refuses it by header; the server underneath must not keep one open either.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { isSubscriptionListen, mcpHttpHandler } from './mcp-http';

const URL_ = 'http://mcp.test/api/mcp';

/** A handler with one tool, plus every response it gave, by `Mcp-Method`. */
function serve() {
  const handler = mcpHttpHandler((server) => {
    server.registerTool(
      'echo',
      { description: 'Echo.', inputSchema: z.object({ msg: z.string() }) },
      async ({ msg }) => ({ content: [{ type: 'text', text: msg }] }),
    );
  }, 'test instructions');
  const responses: Array<{ method: string | null; res: Response }> = [];
  const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const res = await handler.fetch(req);
    responses.push({ method: req.headers.get('mcp-method'), res: res.clone() });
    return res;
  };
  return { fetchFn, responses };
}

async function connect(fetchFn: typeof fetch, modern: boolean): Promise<Client> {
  const client = new Client(
    { name: 'mcp-http-test', version: '0' },
    modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined,
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(URL_), { fetch: fetchFn }));
  return client;
}

/** Whether a response body ends within `ms` (an endless SSE stream does not). */
async function ends(res: Response, ms: number): Promise<boolean> {
  if (!res.body) return true;
  const reader = res.body.getReader();
  const timeout = new Promise<'open'>((r) => setTimeout(() => r('open'), ms));
  for (;;) {
    const next = await Promise.race([reader.read(), timeout]);
    if (next === 'open') {
      await reader.cancel().catch(() => {});
      return false;
    }
    if (next.done) return true;
  }
}

describe('isSubscriptionListen', () => {
  const req = (method?: string) =>
    new Request(URL_, { method: 'POST', headers: method ? { 'Mcp-Method': method } : {} });
  it('spots a listen by its Mcp-Method header, in any case', () => {
    expect(isSubscriptionListen(req('subscriptions/listen'))).toBe(true);
    expect(isSubscriptionListen(req('Subscriptions/Listen'))).toBe(true);
  });
  it('lets everything else through', () => {
    expect(isSubscriptionListen(req('tools/call'))).toBe(false);
    expect(isSubscriptionListen(req())).toBe(false);
  });
});

describe('mcpHttpHandler', () => {
  it('serves a 2025 client: tools, and listChanged is off', async () => {
    const { fetchFn } = serve();
    const client = await connect(fetchFn as typeof fetch, false);
    expect(client.getServerCapabilities()?.tools?.listChanged).toBe(false);
    expect(client.getInstructions()).toBe('test instructions');
    const res = await client.callTool({ name: 'echo', arguments: { msg: 'hi' } });
    expect(res.content).toEqual([{ type: 'text', text: 'hi' }]);
    await client.close();
  });

  it('serves a 2026-07-28 client', async () => {
    const { fetchFn } = serve();
    const client = await connect(fetchFn as typeof fetch, true);
    expect(client.getProtocolEra()).toBe('modern');
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['echo']);
    await client.close();
  });

  it('keeps no listen stream open, even past the route', async () => {
    const { fetchFn, responses } = serve();
    const client = await connect(fetchFn as typeof fetch, true);
    // The subscription is left open while its response is read: a stream
    // that stays open is exactly what must not happen.
    const sub = await client.listen({ toolsListChanged: true }).catch(() => undefined);
    const listens = responses.filter((r) => r.method === 'subscriptions/listen');
    expect(listens.length).toBeGreaterThan(0);
    for (const { res } of listens) expect(await ends(res, 1_000)).toBe(true);
    await sub?.close();
    await client.close();
  });
});
