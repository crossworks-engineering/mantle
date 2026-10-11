/**
 * The admin private-space routes (member logins Phase 7) without a database:
 * the content functions are stood in, so these pin what the ROUTES pass
 * them. Every route acts for the calling admin's OWN space (the acting
 * login's, inside withSpace), every write carries the admin embed rule's
 * writer (the brain the admin administers). Accept and Give back were
 * removed in workspaces W5c (review-gone-routes.test.ts pins their 410). The
 * rules themselves are proven on Postgres in
 * packages/content/src/admin-space.viewer.db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const ADMIN = '55555555-5555-4555-8555-555555555555';
const SPACE = '66666666-6666-4666-8666-666666666666';
const ITEM = '44444444-4444-4444-8444-444444444444';

const h = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown[]]>,
  scopes: [] as unknown[],
  rowType: 'page' as 'page' | 'draw' | 'table' | 'note',
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ({
    id: ANCHOR,
    email: 'a@example.invalid',
    actor: { id: ADMIN, email: 'a@example.invalid', displayName: 'A', isOwner: false },
  })),
}));

vi.mock('@/lib/auth/login-row', () => ({
  loadPersonalSpaceId: vi.fn(async (login: string) => (login === ADMIN ? SPACE : null)),
}));

vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withSpace: vi.fn(async (scope: unknown, fn: () => Promise<unknown>) => {
    h.scopes.push(scope);
    return fn();
  }),
}));

vi.mock('@mantle/content', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const rec =
    (name: string, ret: (...a: unknown[]) => unknown) =>
    async (...args: unknown[]) => {
      h.calls.push([name, args]);
      return ret(...args);
    };
  const item = { row: { id: ITEM }, body: { type: 'note' } };
  return {
    ...real,
    createMineItem: rec('createMineItem', () => ({ id: ITEM })),
    updateMineItem: rec('updateMineItem', () => item),
    assertEditable: rec('assertEditable', () => ({ id: ITEM, type: h.rowType })),
    saveMinePage: rec('saveMinePage', () => ({ ok: true })),
    saveMineDraw: rec('saveMineDraw', () => ({ ok: true })),
    saveMineTable: rec('saveMineTable', () => item),
    getMineItem: rec('getMineItem', () => item),
  };
});

const ctx = { params: Promise.resolve({ id: ITEM }) };
const json = (body: unknown, method = 'POST') =>
  new Request('http://x/api/admin/space', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const writer = { adminOfBrain: ANCHOR };
const callOf = (name: string) => h.calls.find(([n]) => n === name)?.[1];

beforeEach(() => {
  h.calls.length = 0;
  h.scopes.length = 0;
  h.rowType = 'page';
});

describe('admin private-space routes', () => {
  it('create acts in the own space with the admin writer', async () => {
    const { POST } = await import('./route');
    const res = await POST(json({ type: 'note', title: 'n', content: 'x' }));
    expect(res.status).toBe(201);
    expect(h.scopes).toEqual([{ spaceId: SPACE, loginId: ADMIN }]);
    expect(callOf('createMineItem')).toEqual([
      SPACE,
      { type: 'note', title: 'n', content: 'x' },
      writer,
    ]);
  });

  it('rename / note text carries the admin writer', async () => {
    const { PATCH } = await import('./[id]/route');
    const res = await PATCH(json({ content: 'y' }, 'PATCH'), ctx);
    expect(res.status).toBe(200);
    expect(callOf('updateMineItem')).toEqual([SPACE, ITEM, { content: 'y' }, writer]);
  });

  it('Save version of a page, a drawing and a table carries the admin writer', async () => {
    const { POST } = await import('./[id]/save/route');
    const doc = { type: 'doc', content: [] };
    expect((await POST(json({ doc, if_rev: 3 }), ctx)).status).toBe(200);
    expect(callOf('saveMinePage')).toEqual([SPACE, ITEM, doc, { baseRev: 3, ...writer }]);

    h.calls.length = 0;
    h.rowType = 'draw';
    const scene = { elements: [] };
    expect((await POST(json({ scene, svg: '<svg/>' }), ctx)).status).toBe(200);
    expect(callOf('saveMineDraw')).toEqual([
      SPACE,
      ITEM,
      scene,
      { baseRev: undefined, svg: '<svg/>', ...writer },
    ]);

    h.calls.length = 0;
    h.rowType = 'table';
    expect((await POST(json({}), ctx)).status).toBe(200);
    expect(callOf('saveMineTable')).toEqual([SPACE, ITEM, undefined, writer]);
  });
});
