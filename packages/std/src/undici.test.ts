import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fetchStubsApply, fetchThrough, loadUndici } from './undici';

const isBun = !!process.versions.bun;

describe('a call through a dispatcher, the same on every runtime', () => {
  let srv: http.Server;
  let base = '';
  const agent = new (loadUndici()!.Agent)();
  /** The `x-case` of each `/endless` call whose connection closed. */
  const closes: string[] = [];
  const closed = async (name: string) => {
    for (let i = 0; i < 400 && !closes.includes(name); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    return closes.includes(name);
  };

  beforeAll(async () => {
    srv = http.createServer((q, s) => {
      if (q.url === '/hang') return;
      if (q.url === '/endless') {
        const beat = setInterval(() => s.write('x'.repeat(65_536)), 5);
        s.on('close', () => {
          clearInterval(beat);
          closes.push(q.headers['x-case'] as string);
        });
        return;
      }
      const chunks: Buffer[] = [];
      q.on('data', (c: Buffer) => chunks.push(c));
      q.on('end', () => {
        s.setHeader('content-type', 'application/json');
        s.end(
          JSON.stringify({
            method: q.method,
            length: q.headers['content-length'] ?? null,
            chunked: q.headers['transfer-encoding'] ?? null,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    srv.closeAllConnections();
    srv.close();
    await agent.close();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('the package itself, on every runtime: its Agent has a close', () => {
    expect(typeof agent.close).toBe('function');
  });

  it('keeps a Request: its method, its body with a length, an abort of its signal', async () => {
    const req = new Request(`${base}/echo`, { method: 'PUT', body: 'in a request' });
    const res = await fetchThrough(agent, req, {}, fetch);
    expect(await res.json()).toMatchObject({
      method: 'PUT',
      length: '12',
      chunked: null,
      body: 'in a request',
    });
    const ctrl = new AbortController();
    const hung = fetchThrough(agent, new Request(`${base}/hang`, ctrl), {}, fetch);
    ctrl.abort();
    await expect(hung).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('an empty signal in init leaves the signal of the Request in place', async () => {
    const ctrl = new AbortController();
    const init = { signal: undefined } as RequestInit;
    const hung = fetchThrough(agent, new Request(`${base}/hang`, ctrl), init, fetch);
    ctrl.abort();
    await expect(hung).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('keeps a body the caller reads late, past a collection', async () => {
    const gc = (globalThis as { Bun?: { gc: (sync: boolean) => void } }).Bun?.gc;
    // Allocation and an async collection, as under load: a forced full
    // collection on its own does not reach undici's Response in time.
    for (let i = 0; i < 40; i++) {
      const res = await fetchThrough(agent, `${base}/echo`, {}, fetch);
      new Uint8Array(5_000_000).fill(1);
      gc?.(false);
      await new Promise((r) => setTimeout(r, 1));
      expect(await res.json()).toMatchObject({ method: 'GET' });
    }
  }, 30_000);

  it('a cancel of the body ends the connection', async () => {
    const headers = { 'x-case': 'cancelled' };
    const res = await fetchThrough(agent, `${base}/endless`, { headers }, fetch);
    await res.body!.cancel();
    expect(await closed('cancelled')).toBe(true);
  });

  it('an abort after the headers fails the read and ends the connection', async () => {
    const ctrl = new AbortController();
    const init = { signal: ctrl.signal, headers: { 'x-case': 'aborted' } };
    const res = await fetchThrough(agent, `${base}/endless`, init, fetch);
    const read = res.text();
    ctrl.abort();
    await expect(read).rejects.toThrow();
    expect(await closed('aborted')).toBe(true);
  });

  it('an abort stops a Request body that stalls', async () => {
    const ctrl = new AbortController();
    const stalled = new ReadableStream({ start: (c) => c.enqueue(new Uint8Array([1])) });
    const req = new Request(`${base}/echo`, {
      method: 'POST',
      body: stalled,
      signal: ctrl.signal,
      duplex: 'half',
    } as RequestInit);
    const hung = fetchThrough(agent, req, {}, fetch);
    setTimeout(() => ctrl.abort(), 20);
    await expect(hung).rejects.toMatchObject({ name: 'AbortError' });
  });

  it.runIf(isBun)(
    'on Bun, a body the caller drops unread ends the connection',
    async () => {
      const gc = (globalThis as unknown as { Bun: { gc: (sync: boolean) => void } }).Bun.gc;
      const headers = { 'x-case': 'dropped' };
      await fetchThrough(agent, `${base}/endless`, { headers }, fetch);
      for (let i = 0; i < 200 && !closes.includes('dropped'); i++) {
        new Uint8Array(5_000_000).fill(1);
        gc(true);
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(closes).toContain('dropped');
    },
    30_000,
  );

  it('calls a stub as it is, with the dispatcher', async () => {
    const stub = vi.fn(async () => new Response('stubbed'));
    const res = await fetchThrough(agent, `${base}/echo`, {}, stub as unknown as typeof fetch);
    expect(await res.text()).toBe('stubbed');
    expect(stub.mock.calls[0]).toMatchObject([`${base}/echo`, { dispatcher: agent }]);
  });

  it('a replaced fetch is a stub only in a test', () => {
    expect(fetchStubsApply()).toBe(true);
    vi.stubEnv('NODE_ENV', 'production');
    expect(fetchStubsApply()).toBe(false);
  });

  it.runIf(isBun)('on Bun, refuses a wrapped fetch outside a test', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const wrapped = ((u: string) => fetch(u)) as typeof fetch;
    expect(() => fetchThrough(agent, `${base}/echo`, {}, wrapped)).toThrow(/wrapped/);
  });

  it.runIf(isBun)('on Bun, a bound fetch still goes through the Agent', async () => {
    const seen: string[] = [];
    const lookup = (h: string, _o: unknown, cb: (e: Error) => void) => {
      seen.push(h);
      cb(new Error('refused by the lookup'));
    };
    const pinned = new (loadUndici()!.Agent)({ connect: { lookup } as never });
    await expect(
      fetchThrough(pinned, 'http://pin.invalid/', {}, fetch.bind(globalThis)),
    ).rejects.toThrow();
    expect(seen).toEqual(['pin.invalid']);
    await pinned.close();
  });
});
