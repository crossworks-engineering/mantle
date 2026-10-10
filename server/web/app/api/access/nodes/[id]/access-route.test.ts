/**
 * GET / PATCH /api/access/nodes/:id without a database (workspaces W5b2):
 * brain items have no sharing level any more, so both answer 410 with code
 * `gone` and point at Grant Access, and without a session they still answer
 * the gate's 401 (no leak of whether the item exists).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = '33333333-3333-4333-8333-333333333333';
const h = vi.hoisted(() => ({ signedIn: true }));

vi.mock('@/lib/auth', () => ({
  getOwnerOr401: vi.fn(async () =>
    h.signedIn
      ? { id: OWNER }
      : new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
  ),
}));

beforeEach(() => {
  h.signedIn = true;
});

describe('/api/access/nodes/:id is gone', () => {
  it('answers 410 gone to the owner, GET and PATCH alike', async () => {
    const { GET, PATCH } = await import('./route');
    for (const res of [await GET(), await PATCH()]) {
      expect(res.status).toBe(410);
      expect(await res.json()).toEqual({
        error: 'Sharing levels are gone. Use Grant Access.',
        code: 'gone',
      });
    }
  });

  it('still answers 401 without a session', async () => {
    h.signedIn = false;
    const { GET, PATCH } = await import('./route');
    expect((await GET()).status).toBe(401);
    expect((await PATCH()).status).toBe(401);
  });
});
