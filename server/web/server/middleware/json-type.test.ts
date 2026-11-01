import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { jsonTypeOnEveryRuntime } from './json-type';

const BUN_TYPE = 'application/json;charset=utf-8';

async function typeOf(answer: () => Response): Promise<string | null> {
  const app = new Hono();
  app.use('*', jsonTypeOnEveryRuntime());
  app.get('/', answer);
  return (await app.request('/')).headers.get('content-type');
}

const typed = (type: string) => new Response('{}', { headers: { 'content-type': type } });

describe('one Content-Type for JSON on every runtime', () => {
  it("says Bun's JSON type as Node says it", async () => {
    expect(await typeOf(() => typed(BUN_TYPE))).toBe('application/json');
  });

  it('answers Response.json() the same on every runtime', async () => {
    expect(await typeOf(() => Response.json({ a: 1 }))).toBe('application/json');
  });

  it('takes immutable headers too', async () => {
    const frozen = () => {
      const res = typed(BUN_TYPE);
      const set = () => {
        throw new TypeError('immutable');
      };
      return Object.defineProperty(res, 'headers', {
        value: Object.assign(new Headers(res.headers), { set }),
      });
    };
    expect(await typeOf(frozen)).toBe('application/json');
  });

  it('leaves every other type as it is', async () => {
    for (const type of ['application/json; charset=utf-8', 'text/html', 'image/png']) {
      expect(await typeOf(() => typed(type))).toBe(type);
    }
  });
});
