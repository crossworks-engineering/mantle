import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PROVIDER_TIMEOUTS } from '@mantle/std';
import { _setProviderDefaultTimeout, providerFetch } from './provider-fetch';

/**
 * providerFetch's deadline (A10 #10): every call has one; it covers the whole
 * exchange of an ordinary answer and only the headers of an event stream, so
 * a long healthy stream is never cut.
 */

let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/hang') return; // never answers
    if (req.url === '/slow-body') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"a":');
      setTimeout(() => res.end('1}'), 400);
      return;
    }
    if (req.url === '/slow-headers') {
      setTimeout(() => res.end('late'), 400);
      return;
    }
    if (req.url === '/ndjson' || req.url === '/plain') {
      const type = req.url === '/ndjson' ? 'application/x-ndjson' : 'text/plain';
      res.writeHead(200, { 'content-type': type });
      res.write('1\n');
      setTimeout(() => res.end('2\n'), 400);
      return;
    }
    if (req.url === '/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: 1\n\n');
      setTimeout(() => res.end('data: 2\n\n'), 400);
      return;
    }
    res.end('ok');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => _setProviderDefaultTimeout());

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe('providerFetch deadline', () => {
  it('has a named default, generous enough for the slowest provider call', () => {
    expect(PROVIDER_TIMEOUTS.default).toBe(180_000);
    expect(PROVIDER_TIMEOUTS.default).toBeGreaterThanOrEqual(PROVIDER_TIMEOUTS.imageCold);
  });

  it('fails a call that never answers with a TimeoutError', async () => {
    const err = await providerFetch(`${base}/hang`, {}, { timeoutMs: 150 }).catch((e) => e);
    expect((err as Error).name).toBe('TimeoutError');
  });

  it('covers the body of an ordinary answer', async () => {
    const res = await providerFetch(`${base}/slow-body`, {}, { timeoutMs: 150 });
    const err = await res.text().catch((e) => e);
    expect((err as Error).name).toBe('TimeoutError');
  });

  it('covers only the headers of an event stream', async () => {
    const res = await providerFetch(`${base}/stream`, {}, { timeoutMs: 150 });
    await expect(res.text()).resolves.toBe('data: 1\n\ndata: 2\n\n');
  });

  it("still aborts on the caller's own signal", async () => {
    const stop = new AbortController();
    const p = providerFetch(`${base}/hang`, { signal: stop.signal }, { timeoutMs: 60_000 });
    stop.abort(new Error('stop'));
    await expect(p).rejects.toThrow('stop');
  });

  it('answers in time when the provider does', async () => {
    const res = await providerFetch(`${base}/`, {}, { timeoutMs: 1_000 });
    await expect(res.text()).resolves.toBe('ok');
  });

  it('headers scope keeps an ndjson or plain-text stream open past the deadline', async () => {
    for (const path of ['/ndjson', '/plain']) {
      const res = await providerFetch(
        `${base}${path}`,
        {},
        { timeoutMs: 150, timeoutScope: 'headers' },
      );
      await expect(res.text()).resolves.toBe('1\n2\n');
    }
  });

  it('the auto scope still covers the body of a stream that is not typed event-stream', async () => {
    const res = await providerFetch(`${base}/ndjson`, {}, { timeoutMs: 150 });
    const err = await res.text().catch((e) => e);
    expect((err as Error).name).toBe('TimeoutError');
  });
});

describe('providerFetch default deadline (a stand-in of 150 ms)', () => {
  it('applies to a call with no signal and no named deadline', async () => {
    _setProviderDefaultTimeout(150);
    const err = await providerFetch(`${base}/slow-headers`).catch((e) => e);
    expect((err as Error).name).toBe('TimeoutError');
  });

  it("never cuts a caller's own longer signal at the default", async () => {
    _setProviderDefaultTimeout(150);
    const res = await providerFetch(`${base}/slow-headers`, { signal: AbortSignal.timeout(5_000) });
    await expect(res.text()).resolves.toBe('late');
  });

  it('a named deadline longer than the default wins over it', async () => {
    _setProviderDefaultTimeout(150);
    const res = await providerFetch(`${base}/slow-headers`, {}, { timeoutMs: 5_000 });
    await expect(res.text()).resolves.toBe('late');
  });
});
