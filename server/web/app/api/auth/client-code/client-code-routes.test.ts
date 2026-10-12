/**
 * Email-code sign-in, removed in workspaces W8a: GET and POST
 * /api/auth/client-code and POST /api/auth/client-code/verify answer every
 * caller 410 `{ error, code: 'gone' }`, before any work. Nothing is read
 * (no session, no body, no code), nothing is queued and nothing is minted:
 * every session reader fails the test if it is called.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth', () => {
  const never = () => {
    throw new Error('the gone sign-in routes must not read a session');
  };
  return { getOwnerOr401: never, getMemberOr401: never, getLoginOr401: never };
});

type Handler = (req?: Request) => Promise<Response>;

const routes: Array<[string, string, () => Promise<Record<string, Handler>>]> = [
  ['GET', '/api/auth/client-code', () => import('./route')],
  ['POST', '/api/auth/client-code', () => import('./route')],
  ['POST', '/api/auth/client-code/verify', () => import('./verify/route')],
];

describe('email-code sign-in is gone (W8a)', () => {
  it.each(routes)('%s %s answers 410 code gone', async (method, path, load) => {
    const mod = await load();
    const handler = mod[method]!;
    const req = new Request(`https://brain.example.invalid${path}`, {
      method,
      ...(method === 'POST'
        ? {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: 'someone@example.invalid', code: '123456' }),
          }
        : {}),
    });
    const res = await handler(req);
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ code: 'gone' });
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('exports no other method', async () => {
    expect(Object.keys(await import('./route')).sort()).toEqual(['GET', 'POST']);
    expect(Object.keys(await import('./verify/route'))).toEqual(['POST']);
  });
});
