/**
 * The listener's request deadlines (listener-timeouts.ts).
 *
 * Node's default requestTimeout (300 s) answered 408 to a 451 MB upload from
 * a home uplink at 309 s (dev, 2026-11-02). This pins the deadline main.ts
 * sets: long enough for the streamed cap on a slow link, still finite, and
 * the header deadline kept. It also pins the idle keep-alive time above
 * Caddy's upstream pool time.
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES } from '@mantle/files';
import {
  CADDY_UPSTREAM_IDLE_MS,
  HEADERS_TIMEOUT_MS,
  KEEP_ALIVE_TIMEOUT_MS,
  MIN_REQUEST_TIMEOUT_MS,
  UPLOAD_FLOOR_BYTES_PER_SEC,
  applyListenerTimeouts,
  requestTimeoutFor,
} from './listener-timeouts';

const MB = 1024 * 1024;

describe('listener timeouts', () => {
  it('a full-size upload finishes at the floor rate', () => {
    for (const capMb of [64, 512, 2048]) {
      const cap = capMb * MB;
      const needed = (cap / UPLOAD_FLOOR_BYTES_PER_SEC) * 1000;
      expect(requestTimeoutFor(cap)).toBeGreaterThanOrEqual(needed);
    }
  });

  it('the 2026-11-02 upload fits: 451 MB at 1.1 MB/s', () => {
    expect(requestTimeoutFor(512 * MB)).toBeGreaterThan(((451 * MB) / (1.1 * MB)) * 1000);
  });

  it('never drops under an hour, and never turns off', () => {
    expect(requestTimeoutFor(MAX_UPLOAD_BYTES)).toBe(MIN_REQUEST_TIMEOUT_MS);
    expect(requestTimeoutFor(0)).toBe(MIN_REQUEST_TIMEOUT_MS);
    // 0 is Node's "no deadline": a trickled body would hold a socket for ever.
    expect(requestTimeoutFor(512 * MB)).toBeGreaterThan(0);
    expect(requestTimeoutFor(512 * MB)).toBe(
      Math.ceil(((512 * MB) / UPLOAD_FLOOR_BYTES_PER_SEC) * 1000),
    );
  });

  it('keeps the header deadline short and under the request deadline', () => {
    expect(HEADERS_TIMEOUT_MS).toBe(60_000);
    expect(HEADERS_TIMEOUT_MS).toBeLessThan(requestTimeoutFor(0));
  });

  it('keeps an idle socket longer than Caddy keeps one in its pool', () => {
    // The server must never close a socket Caddy may still reuse: a POST
    // sent on it would end as a 502 with no CORS headers.
    expect(CADDY_UPSTREAM_IDLE_MS).toBe(120_000); // Caddy's reverse_proxy keepalive default
    expect(KEEP_ALIVE_TIMEOUT_MS).toBeGreaterThan(CADDY_UPSTREAM_IDLE_MS);
  });

  it('no release Caddy file sets its own upstream keepalive', () => {
    // A `keepalive` in a transport block would replace Caddy's 2 min default,
    // and CADDY_UPSTREAM_IDLE_MS would be wrong. Change both together.
    const dir = join(__dirname, '../../../infra/caddy');
    const files = [
      'Caddyfile',
      ...readdirSync(join(dir, 'shapes')).map((f) => join('shapes', f)),
      ...readdirSync(join(dir, 'conf.d'))
        .filter((f) => f.endsWith('.caddy'))
        .map((f) => join('conf.d', f)),
    ];
    expect(files.length).toBeGreaterThan(2);
    for (const f of files) {
      const code = readFileSync(join(dir, f), 'utf8')
        .split('\n')
        .map((line) => line.replace(/#.*/, ''))
        .join('\n');
      expect(code, f).not.toMatch(/\bkeepalive\b/);
    }
  });

  it('sets all three on the listener serve() returns, and the runtime uses them', async () => {
    const server = serve({
      fetch: new Hono().get('/', (c) => c.text('ok')).fetch,
      port: 0,
      hostname: '127.0.0.1',
      overrideGlobalObjects: false,
    }) as Server;
    try {
      expect(server.requestTimeout).toBe(300_000); // Node's default, the one that cut the upload
      expect(server.keepAliveTimeout).toBe(5_000); // the default that Caddy's pool outlives
      applyListenerTimeouts(server, 512 * MB);
      expect(server.requestTimeout).toBe(requestTimeoutFor(512 * MB));
      expect(server.headersTimeout).toBe(HEADERS_TIMEOUT_MS);
      expect(server.keepAliveTimeout).toBe(KEEP_ALIVE_TIMEOUT_MS);
      // The runtime itself takes the value: it tells the client how long it
      // keeps the socket.
      if (!server.listening) await new Promise((done) => server.once('listening', done));
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/`);
      await res.text();
      expect(res.headers.get('keep-alive')).toBe(`timeout=${KEEP_ALIVE_TIMEOUT_MS / 1000}`);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  it('main.ts applies them to its listener with the streamed upload cap', () => {
    const main = readFileSync(join(__dirname, 'main.ts'), 'utf8');
    expect(main).toMatch(
      /applyListenerTimeouts\(\s*server\b[^,]*,\s*maxStreamedUploadBytes\(\)\s*\)/,
    );
  });
});
