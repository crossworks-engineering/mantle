/**
 * web_fetch against a real loopback server (A10 part 1 fix round 1): the
 * IPv6 forms of a loopback or metadata address are refused end to end. The
 * URL parser rewrites `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, which the
 * check once missed, so the tool read the loopback server.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ToolHandlerContext } from '../types';
import { web_fetch } from './web-fetch';

let srv: http.Server;
let port = 0;
let hits = 0;

beforeAll(async () => {
  srv = http.createServer((_q, s) => {
    hits++;
    s.end('INTERNAL-ONLY');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  port = (srv.address() as AddressInfo).port;
});

afterAll(() => {
  srv.close();
});

const ctx = { ownerId: 'o' } as unknown as ToolHandlerContext;

describe('web_fetch and IPv6 forms of a private address', () => {
  it('refuses the mapped, compatible and translated forms of loopback', async () => {
    for (const host of [
      '[::ffff:127.0.0.1]',
      '[::ffff:7f00:1]',
      '[::127.0.0.1]',
      '[::ffff:0:7f00:1]',
    ]) {
      const r = await web_fetch.handler({ url: `http://${host}:${port}/` }, ctx);
      expect(r.ok, host).toBe(false);
      expect(JSON.stringify(r), host).toMatch(/private\/internal address/);
      expect(JSON.stringify(r), host).not.toMatch(/INTERNAL-ONLY/);
    }
    expect(hits).toBe(0);
  });

  it('refuses the mapped metadata address', async () => {
    const r = await web_fetch.handler(
      { url: 'http://[::ffff:169.254.169.254]/latest/meta-data/' },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toMatch(/private\/internal address/);
  });
});
