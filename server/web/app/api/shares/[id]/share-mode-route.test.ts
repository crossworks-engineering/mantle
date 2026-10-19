/**
 * PATCH /api/shares/:id without a database (member logins Phase 6 stage 6):
 * team links are retired, so `mode: 'team'` is a 400 with reason
 * `team-links-retired` and a message that says members use their own logins,
 * and the store is never called. `public` still goes through; anything else
 * is a plain 400. DELETE answers `{ ok }` only (no level talk since W5b2).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const SHARE = '44444444-4444-4444-8444-444444444444';

const h = vi.hoisted(() => ({
  modes: [] as string[],
  found: true,
  byArea: 'no-area' as 'closed' | 'gone' | 'no-area',
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ({
    id: ANCHOR,
    email: 'admin@example.invalid',
    actor: { id: ANCHOR, email: 'admin@example.invalid' },
  })),
  // The reader a converted handler calls (A4 step 3b): the same stand-in.
  ownerCaller: vi.fn(() => ({
    id: ANCHOR,
    email: 'admin@example.invalid',
    actor: { id: ANCHOR, email: 'admin@example.invalid' },
  })),
}));

vi.mock('@/lib/shares', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  applyShareMode: vi.fn(async (_owner: string, _id: string, mode: string) => {
    h.modes.push(mode);
    return h.found;
  }),
  getLiveShare: vi.fn(async () => ({ id: SHARE, nodeId: ANCHOR, contactId: null, served: [] })),
  revokeShare: vi.fn(async () => true),
}));

vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/content')>()),
  assertMayLink: vi.fn(async () => ({ id: ANCHOR, type: 'note', path: null })),
  // The Admin acts (plan v3.2 S6 c2, migration 0310): no users area, and no
  // contact share by this id, so the link's rule answers below.
  adminCloseShare: vi.fn(async () => h.byArea),
  adminSetContactShareCanWrite: vi.fn(async () => ({ outcome: 'not-contact' })),
}));

// The link check in the login's scope: the caller may change this link.
vi.mock('@/lib/auth/item-answers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  shareItemRefusal: vi.fn(async () => null),
}));

beforeEach(() => {
  h.modes = [];
  h.found = true;
  h.byArea = 'no-area';
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
  it('answers ok only', async () => {
    const { DELETE } = await import('./route');
    const res = await DELETE(new Request(`https://brain.example.invalid/api/shares/${SHARE}`), {
      params: Promise.resolve({ id: SHARE }),
    });
    expect(await res.json()).toEqual({ ok: true });
  });

  it('an Admin user with the users area: the definer closes it, ok as it answers', async () => {
    const { DELETE } = await import('./route');
    const del = () =>
      DELETE(new Request(`https://brain.example.invalid/api/shares/${SHARE}`), {
        params: Promise.resolve({ id: SHARE }),
      });
    h.byArea = 'closed';
    expect(await (await del()).json()).toEqual({ ok: true });
    h.byArea = 'gone';
    expect(await (await del()).json()).toEqual({ ok: false });
  });

  it('an id that is no uuid: the item gate’s one 404', async () => {
    const { DELETE } = await import('./route');
    const res = await DELETE(new Request('https://brain.example.invalid/api/shares/x'), {
      params: Promise.resolve({ id: 'x' }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: 'not found' });
  });
});
