/**
 * The listener's request deadlines (listener-timeouts.ts).
 *
 * Node's default requestTimeout (300 s) answered 408 to a 451 MB upload from
 * a home uplink at 309 s (dev, 2026-11-02). This pins the deadline main.ts
 * sets: long enough for the streamed cap on a slow link, still finite, and
 * the header deadline kept.
 */
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES } from '@mantle/files';
import {
  HEADERS_TIMEOUT_MS,
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

  it('sets both on the listener serve() returns', async () => {
    const server = serve({
      fetch: new Hono().fetch,
      port: 0,
      hostname: '127.0.0.1',
      overrideGlobalObjects: false,
    }) as Server;
    try {
      expect(server.requestTimeout).toBe(300_000); // Node's default, the one that cut the upload
      applyListenerTimeouts(server, 512 * MB);
      expect(server.requestTimeout).toBe(requestTimeoutFor(512 * MB));
      expect(server.headersTimeout).toBe(HEADERS_TIMEOUT_MS);
    } finally {
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
