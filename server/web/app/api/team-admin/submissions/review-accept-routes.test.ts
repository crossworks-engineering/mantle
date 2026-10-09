/**
 * The review Accept routes without a database (client logins C1, audit A28):
 * the bundle preview asks for the closure of the brain it will move into,
 * Accept forwards the confirmation and the ticked closure ids, and a
 * `confirm-level` refusal answers 409 with `goingDown` for the dialog. The
 * rule itself is proven on Postgres in
 * packages/content/src/client-space.viewer.db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const ADMIN = '55555555-5555-4555-8555-555555555555';
const ITEM = '44444444-4444-4444-8444-444444444444';
const FILE = '77777777-7777-4777-8777-777777777777';

const h = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown[]]>,
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

vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  previewAccept: vi.fn(async (...args: unknown[]) => {
    h.calls.push(['previewAccept', args]);
    return { items: [], linksStayingBehind: 0, closure: [] };
  }),
  acceptReviewItem: vi.fn(async (...args: unknown[]) => {
    h.calls.push(['acceptReviewItem', args]);
    return h.accept
      ? h.accept()
      : { id: ITEM, audience: 'public', moved: [], linksStayingBehind: 0, alsoLowered: [] };
  }),
}));

const ctx = { params: Promise.resolve({ id: ITEM }) };
const post = (body: unknown) =>
  new Request('http://x/api/team-admin/submissions/x/accept', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const callOf = (name: string) => h.calls.find(([n]) => n === name)?.[1];

beforeEach(() => {
  h.calls.length = 0;
  h.accept = null;
});

describe('review Accept routes', () => {
  it('the bundle preview asks for the closure in this brain', async () => {
    const { GET } = await import('./[id]/bundle/route');
    const res = await GET(new Request('http://x'), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [], linksStayingBehind: 0, closure: [] });
    expect(callOf('previewAccept')).toEqual([ITEM, ANCHOR, undefined]);
  });

  it('the bundle preview works the place out for a picked folder, or the top level', async () => {
    const { GET } = await import('./[id]/bundle/route');
    expect((await GET(new Request(`http://x?folderId=${FILE}`), ctx)).status).toBe(200);
    expect(callOf('previewAccept')).toEqual([ITEM, ANCHOR, FILE]);
    h.calls.length = 0;
    expect((await GET(new Request('http://x?folderId=root'), ctx)).status).toBe(200);
    expect(callOf('previewAccept')).toEqual([ITEM, ANCHOR, null]);
    expect((await GET(new Request('http://x?folderId=nope'), ctx)).status).toBe(404);
  });

  it('Accept forwards visibilityConfirmed, and a visibility refusal carries the list', async () => {
    const { POST } = await import('./[id]/accept/route');
    expect((await POST(post({ visibilityConfirmed: true }), ctx)).status).toBe(200);
    // The route always asks for the pin (the caller's is checked under lock).
    expect(callOf('acceptReviewItem')?.[3]).toEqual({
      visibilityConfirmed: true,
      requirePin: true,
    });
    const { ReviewError } = await import('@mantle/content');
    const changes = [{ id: FILE, title: 'x', from: 'admin' as const, to: 'client' as const }];
    const res = (await import('@/lib/member-review')).reviewErrorResponse(
      new ReviewError('visibility', 'lands shared', undefined, { changes, total: 1 }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'lands shared',
      reason: 'visibility',
      changes,
      total: 1,
    });
  });

  it('Accept forwards lowerConfirmed and confirmedIds', async () => {
    const { POST } = await import('./[id]/accept/route');
    const body = { audience: 'public', lowerConfirmed: true, confirmedIds: [FILE] };
    expect((await POST(post(body), ctx)).status).toBe(200);
    expect(callOf('acceptReviewItem')?.[3]).toEqual({ ...body, requirePin: true });
    // A client cannot switch the pin off: an unknown key is dropped.
    h.calls.length = 0;
    expect((await POST(post({ requirePin: false }), ctx)).status).toBe(200);
    expect(callOf('acceptReviewItem')?.[3]).toEqual({ requirePin: true });
    expect((await POST(post({ confirmedIds: ['nope'] }), ctx)).status).toBe(400);
  });

  it('a confirm-level refusal is 409 with goingDown', async () => {
    const { POST } = await import('./[id]/accept/route');
    const { ReviewError } = await import('@mantle/content');
    const goingDown = [{ id: FILE, type: 'file', title: 'plan.pdf', audience: 'client' }];
    h.accept = async () => {
      throw new ReviewError('confirm-level', 'A client wrote this.', goingDown as never);
    };
    const res = await POST(post({ audience: 'public', lowerConfirmed: true }), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'A client wrote this.',
      reason: 'confirm-level',
      goingDown,
    });
  });
});
