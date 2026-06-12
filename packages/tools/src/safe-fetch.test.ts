/**
 * safeFetch must drop secret-bearing headers the moment a redirect crosses
 * origin, while still following same-origin redirects with the header intact.
 */

import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { safeFetch } from './safe-fetch';

const SECRET = 'pk.SUPER-SECRET-123';

// Two independent origins on different ports so a hop between them is cross-origin.
let evil: Server;
let evilPort = 0;
const seenByEvil: Array<string | undefined> = [];

let app: Server;
let appPort = 0;

function listen(s: Server): Promise<number> {
  return new Promise((res) => s.listen(0, () => res((s.address() as { port: number }).port)));
}

beforeAll(async () => {
  evil = createServer((req, res) => {
    seenByEvil.push(req.headers['x-api-key'] as string | undefined);
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('evil-ok');
  });
  evilPort = await listen(evil);

  app = createServer((req, res) => {
    if (req.url === '/cross') {
      res.writeHead(302, { location: `http://127.0.0.1:${evilPort}/harvest` });
      res.end();
    } else if (req.url === '/same') {
      res.writeHead(302, { location: `http://127.0.0.1:${appPort}/final` });
      res.end();
    } else {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`same-origin saw=${req.headers['x-api-key'] ?? 'none'}`);
    }
  });
  appPort = await listen(app);
});

afterAll(() => {
  evil.close();
  app.close();
});

describe('safeFetch', () => {
  it('drops a secret-bearing header on a cross-origin redirect', async () => {
    const res = await safeFetch(
      `http://127.0.0.1:${appPort}/cross`,
      { headers: { 'x-api-key': SECRET } },
      [SECRET],
    );
    expect(await res.text()).toBe('evil-ok');
    expect(seenByEvil.at(-1)).toBeUndefined(); // header was stripped before the cross-origin hop
  });

  it('keeps the header across a same-origin redirect', async () => {
    const res = await safeFetch(
      `http://127.0.0.1:${appPort}/same`,
      { headers: { 'x-api-key': SECRET } },
      [SECRET],
    );
    expect(await res.text()).toBe(`same-origin saw=${SECRET}`);
  });

  it('returns non-redirect responses unchanged', async () => {
    const res = await safeFetch(`http://127.0.0.1:${appPort}/final`, {}, []);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('same-origin saw=none');
  });
});
