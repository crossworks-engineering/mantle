/**
 * GET and POST /api/runs/:id show and cancel a run only for its own login,
 * and a run naming no login only for the brain owner's login
 * (lib/runs-visible.ts): Admin B is answered 404 for Admin A's run and a
 * member's, as for a run that is not there, and cancels nothing. No
 * database: the compiled run, the caller and the cancel are stood in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const BRAIN = '11111111-1111-4111-8111-111111111111';
const ADMIN_B = '22222222-2222-4222-8222-222222222222';
const MEMBER = '33333333-3333-4333-8333-333333333333';
const RUN = '44444444-4444-4444-8444-444444444444';

const h = vi.hoisted(() => ({
  viewer: '',
  run: null as null | { ownerId: string; loginId: string | null; title: string },
  cancelled: 0,
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ownerCaller: () => ({ id: '11111111-1111-4111-8111-111111111111', actor: { id: h.viewer } }),
}));
vi.mock('@mantle/runs', () => ({
  compileRunState: async () =>
    h.run
      ? {
          run: { ownerId: h.run.ownerId, title: h.run.title },
          items: [{ id: 'i1', title: 'read the window text' }],
        }
      : null,
  cancelRun: async () => {
    h.cancelled += 1;
    return { cancelled: true };
  },
}));
vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  // The run row's login, as the route reads it.
  const rows = () => (h.run ? [{ loginId: h.run.loginId }] : []);
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => rows(),
  };
  return {
    ...actual,
    db: { select: () => chain },
    onFullSystemRoute: async <T>(_spot: string, fn: () => Promise<T>) => fn(),
  };
});

const { GET, POST } = await import('./route');

const params = { params: Promise.resolve({ id: RUN }) };
const get = () => GET(new Request(`http://brain.invalid/api/runs/${RUN}`), params);
const cancel = () =>
  POST(
    new Request(`http://brain.invalid/api/runs/${RUN}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'cancel' }),
    }),
    params,
  );

beforeEach(() => {
  h.cancelled = 0;
});

describe("a run is its own login's", () => {
  it("Admin B: Admin A's run and a member's are not found, and are not cancelled", async () => {
    h.viewer = ADMIN_B;
    for (const loginId of [BRAIN, MEMBER]) {
      h.run = { ownerId: BRAIN, loginId, title: 'A run' };
      const res = await get();
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain('window text');
      expect((await cancel()).status).toBe(404);
    }
    expect(h.cancelled).toBe(0);
  });

  it('its own login reads and cancels it', async () => {
    h.viewer = ADMIN_B;
    h.run = { ownerId: BRAIN, loginId: ADMIN_B, title: 'B run' };
    expect((await get()).status).toBe(200);
    expect((await cancel()).status).toBe(200);
    expect(h.cancelled).toBe(1);
  });

  it("a run naming no login: the brain owner's login only", async () => {
    h.run = { ownerId: BRAIN, loginId: null, title: 'An old run' };
    h.viewer = ADMIN_B;
    expect((await get()).status).toBe(404);
    h.viewer = BRAIN;
    expect((await get()).status).toBe(200);
  });
});
