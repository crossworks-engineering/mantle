/**
 * GET / PATCH /api/access/nodes/:id without a database (workspaces W5b2):
 * brain items have no sharing level any more, so both answer 410 with code
 * `gone` and point at Grant Access, and without a session they still answer
 * the gate's 401 (no leak of whether the item exists).
 */
import { describe, expect, it, vi } from 'vitest';

const OWNER = '33333333-3333-4333-8333-333333333333';

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // The route reads the caller the pipeline answers (A4 step 3b part 4).
  ownerCaller: vi.fn(() => ({ id: OWNER })),
}));

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
    // Through the full pipeline (runRoute): the refusal is the gate's since
    // the route reads the caller it answers; the handler never runs.
    const { runRoute } = await import('@/server/run-route');
    expect((await runRoute(null, 'GET', `/api/access/nodes/${OWNER}`)).status).toBe(401);
    expect((await runRoute(null, 'PATCH', `/api/access/nodes/${OWNER}`, {})).status).toBe(401);
  });
});
