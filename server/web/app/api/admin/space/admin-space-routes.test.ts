/**
 * The admin private-space routes (member logins Phase 7) without a database:
 * the content functions are stood in, so these pin what the ROUTES pass
 * them. Every route acts for the calling admin's OWN space (the acting
 * login's, inside withSpace), every write carries the admin embed rule's
 * writer (the brain the admin administers), and Accept passes the brain, the
 * own space and the login, with the team-admin accept body and answer. The
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
  accept: null as null | (() => Promise<unknown>),
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
    acceptOwnItem: vi.fn(async (...args: unknown[]) => {
      h.calls.push(['acceptOwnItem', args]);
      return h.accept
        ? h.accept()
        : { id: ITEM, audience: 'admin', moved: [], linksStayingBehind: 0 };
    }),
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
  h.accept = null;
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

  it('Accept passes the brain, the own space and login, and the team-admin body', async () => {
    const { POST } = await import('./[id]/accept/route');
    const body = { audience: 'team', parentPageId: null, folderPath: 'files/x' };
    const res = await POST(json(body), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: ITEM,
      audience: 'admin',
      moved: [],
      linksStayingBehind: 0,
    });
    expect(callOf('acceptOwnItem')).toEqual([
      ANCHOR,
      { spaceId: SPACE, loginId: ADMIN },
      ITEM,
      body,
    ]);
  });

  it('Accept after Take over passes the confirmation and the ticked ids (audit A6)', async () => {
    const { POST } = await import('./[id]/accept/route');
    const FILE = '77777777-7777-4777-8777-777777777777';
    const body = { audience: 'public', lowerConfirmed: true, confirmedIds: [FILE] };
    expect((await POST(json(body), ctx)).status).toBe(200);
    expect(callOf('acceptOwnItem')?.[3]).toEqual(body);
    // A refusal carries what would go down with it, for the dialog to tick.
    const { ReviewError } = await import('@mantle/content');
    const goingDown = [{ id: FILE, type: 'file', title: 'plan.pdf', audience: 'client' }];
    h.accept = async () => {
      throw new ReviewError('confirm-level', 'A client wrote this.', goingDown as never);
    };
    const res = await POST(json({ audience: 'public', lowerConfirmed: true }), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'A client wrote this.',
      reason: 'confirm-level',
      goingDown,
    });
    h.accept = null;
    expect((await POST(json({ confirmedIds: ['nope'] }), ctx)).status).toBe(400);
  });

  it('Accept answers the refusals: 409 unsaved-draft, 404, 400', async () => {
    const { POST } = await import('./[id]/accept/route');
    const { ReviewError, SpaceItemStateError } = await import('@mantle/content');
    h.accept = async () => {
      throw new SpaceItemStateError('unsaved-draft', 'Save first.');
    };
    const res = await POST(json({}), ctx);
    expect([res.status, ((await res.json()) as { reason?: string }).reason]).toEqual([
      409,
      'unsaved-draft',
    ]);
    h.accept = async () => {
      throw new SpaceItemStateError('not-found', 'Not found.');
    };
    expect((await POST(json({}), ctx)).status).toBe(404);
    h.accept = async () => {
      throw new ReviewError('invalid', 'Pick a folder under Files.');
    };
    expect((await POST(json({}), ctx)).status).toBe(400);
    expect((await POST(json({ audience: 'everyone' }), ctx)).status).toBe(400);
    const bad = await POST(json({}), { params: Promise.resolve({ id: 'nope' }) });
    expect(bad.status).toBe(404);
  });
});
