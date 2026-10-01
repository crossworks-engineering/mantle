/**
 * PATCH /api/shares/:id without a database (member logins Phase 6 stage 6):
 * team links are retired, so `mode: 'team'` is a 400 with reason
 * `team-links-retired` and a message that says members use their own logins,
 * and the store is never called. `public` still goes through; anything else
 * is a plain 400. DELETE answers without the retired `keptTeam` flag.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const SHARE = '44444444-4444-4444-8444-444444444444';

const h = vi.hoisted(() => ({ modes: [] as string[], found: true }));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ({ id: ANCHOR, email: 'admin@example.invalid' })),
}));

vi.mock('@/lib/shares', () => ({
  applyShareMode: vi.fn(async (_owner: string, _id: string, mode: string) => {
    h.modes.push(mode);
    return h.found;
  }),
}));

vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/content')>()),
  unshareItem: vi.fn(async () => ({ revoked: true, stillBelow: [] })),
}));

beforeEach(() => {
  h.modes = [];
  h.found = true;
});

const patch = async (body: unknown) => {
  const { PATCH } = await import('./route');
  return PATCH(
    new Request(`https://brain.example.invalid/api/shares/${SHARE}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: SHARE }) },
  );
};

describe('PATCH /api/shares/:id', () => {
  it('refuses a team link with team-links-retired and writes nothing', async () => {
    const res = await patch({ mode: 'team' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.reason).toBe('team-links-retired');
    expect(body.error).toMatch(/own logins/);
    expect(h.modes).toEqual([]);
  });

  it('keeps public working', async () => {
    const res = await patch({ mode: 'public' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.modes).toEqual(['public']);
    h.found = false;
    expect((await patch({ mode: 'public' })).status).toBe(404);
  });

  it('answers a plain 400 for any other mode', async () => {
    for (const body of [{ mode: 'everyone' }, {}, { mode: 3 }]) {
      const res = await patch(body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { reason?: string }).reason).toBeUndefined();
    }
    expect(h.modes).toEqual([]);
  });
});

describe('DELETE /api/shares/:id', () => {
  it('answers ok and stillBelow only', async () => {
    const { DELETE } = await import('./route');
    const res = await DELETE(new Request(`https://brain.example.invalid/api/shares/${SHARE}`), {
      params: Promise.resolve({ id: SHARE }),
    });
    expect(await res.json()).toEqual({ ok: true, stillBelow: [] });
  });
});
