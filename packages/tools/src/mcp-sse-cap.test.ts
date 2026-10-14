/**
 * The standing GET event stream of an MCP connector and of a linked peer's
 * MCP endpoint takes no total byte cap (it lives for the session), so each
 * event on it is capped (SSE_MAX_EVENT_BYTES, docs/egress.md). Real loopback
 * servers: a hostile one sending one endless line, and a healthy one whose
 * stream outgrows the cap in total but never in one event.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EgressTooLargeError, SSE_MAX_EVENT_BYTES } from '@mantle/std/egress';
import { mcpConnectorFetch } from './mcp-client';
import { peerMcpFetch } from './builtins-peer-mcp';

const MB = 1024 * 1024;

let srv: http.Server;
let base = '';
/** Bytes the hostile route got onto the socket before the client let go. */
let endlessWritten = 0;

beforeAll(async () => {
  srv = http.createServer((q, s) => {
    s.writeHead(200, { 'content-type': 'text/event-stream' });
    if (q.url!.endsWith('/endless-line') || q.url!.endsWith('/endless-event')) {
      // One line that never ends, or one event of 1 KB data lines that never
      // reaches its blank line: both are held whole by the client's parser.
      const chunk = q.url!.endsWith('/endless-line')
        ? Buffer.alloc(64 * 1024, 0x78)
        : Buffer.from(`data: ${'y'.repeat(1018)}\n`.repeat(64));
      s.write('data: ');
      let open = true;
      s.on('close', () => (open = false));
      const pump = () => {
        while (open && endlessWritten < 64 * MB) {
          endlessWritten += chunk.length;
          if (!s.write(chunk)) {
            s.once('drain', pump);
            return;
          }
        }
        s.end();
      };
      pump();
      return;
    }
    // Healthy: keep-alive comments, then 12 events of 1 MB each (12 MB in
    // total, three times the per-event cap), then the stream stays open.
    s.write(': keep-alive\n\n:\n');
    const line = `data: ${'z'.repeat(64 * 1024 - 7)}\n`;
    for (let i = 0; i < 12; i++) s.write(`event: message\r\n${line.repeat(16)}\r\n`);
    s.write('data: last\n\n');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  // The connector fetch refuses loopback; the sandbox service proxy carve
  // (SANDBOXD_URL + /svc/) is the one way it reaches a loopback server.
  vi.stubEnv('SANDBOXD_URL', base);
});
afterAll(() => {
  vi.unstubAllEnvs();
  srv.closeAllConnections();
  srv.close();
});
afterEach(() => {
  endlessWritten = 0;
});

const sseGet = { method: 'GET', headers: { accept: 'text/event-stream' } };

const FETCHES: Array<[string, typeof fetch]> = [
  ['MCP connector', mcpConnectorFetch],
  ['peer MCP transport', peerMcpFetch],
];

describe.each(FETCHES)('%s: the standing GET event stream', (_name, f) => {
  it('fails the read on one endless line, without reading on', async () => {
    const res = await f(`${base}/svc/endless-line`, sseGet);
    const err = await res.text().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EgressTooLargeError);
    expect((err as Error).message).toMatch(/event-stream event is over the 4194304-byte cap/);
    expect(endlessWritten).toBeLessThan(64 * MB);
  });

  it('fails the read on one event that never reaches its blank line', async () => {
    const res = await f(`${base}/svc/endless-event`, sseGet);
    await expect(res.text()).rejects.toBeInstanceOf(EgressTooLargeError);
    expect(endlessWritten).toBeLessThan(64 * MB);
  });

  it('keeps a healthy stream that outgrows the cap only in total', async () => {
    const res = await f(`${base}/svc/healthy`, sseGet);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = '';
    while (!text.includes('data: last\n\n')) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
    }
    await reader.cancel();
    expect(text.length).toBeGreaterThan(3 * SSE_MAX_EVENT_BYTES);
    expect(text.split('event: message').length - 1).toBe(12);
  });
});
