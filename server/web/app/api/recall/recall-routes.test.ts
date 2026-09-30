/**
 * The Recall owner routes as HTTP: what reaches the write module, and the
 * status each refusal becomes. The write module itself is tested against
 * Postgres (packages/content/src/recall-native.db.test.ts); these stand the
 * session and the module in, so they run without a database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as { fn: string; args: unknown[] }[],
  fail: null as null | { code: string },
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ({
    id: '00000000-0000-4000-8000-000000000001',
    actor: { id: '00000000-0000-4000-8000-000000000002', displayName: 'Admin' },
  })),
}));

vi.mock('@mantle/content', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/content')>();
  const record =
    (fn: string) =>
    async (...args: unknown[]) => {
      h.calls.push({ fn, args });
      if (h.fail) throw new real.RecallWriteError(h.fail.code, `refused: ${h.fail.code}`);
      return { version: 2, warnings: [] };
    };
  return {
    ...real,
    putRecallCard: record('putRecallCard'),
    deleteRecallCard: record('deleteRecallCard'),
  };
});

const MAP = '00000000-0000-4000-8000-0000000000aa';
const ctx = { params: Promise.resolve({ id: MAP, card: 'box' }) };
const url = (q = '') => `http://brain.example/api/recall/maps/${MAP}/cards/box${q}`;

beforeEach(() => {
  h.calls = [];
  h.fail = null;
});

describe('DELETE /api/recall/maps/:id/cards/:card', () => {
  it('refuses a delete without ?version as a bad request, not a stale version', async () => {
    const { DELETE } = await import('./maps/[id]/cards/[card]/route');
    const res = await DELETE(new Request(url(), { method: 'DELETE' }), ctx);
    expect(res.status).toBe(400);
    expect(h.calls).toHaveLength(0);
  });

  it('passes the version it was sent', async () => {
    const { DELETE } = await import('./maps/[id]/cards/[card]/route');
    const res = await DELETE(new Request(url('?version=3'), { method: 'DELETE' }), ctx);
    expect(res.status).toBe(200);
    expect(h.calls[0]!.args[4]).toBe(3);
  });

  it.each([
    ['version_stale', 409],
    ['card_not_found', 404],
    ['map_not_found', 404],
    ['cross_map_not_found', 400],
    ['folder_not_found', 400],
    ['revision_not_restorable', 400],
  ])('answers %s with %i', async (code, status) => {
    h.fail = { code };
    const { DELETE } = await import('./maps/[id]/cards/[card]/route');
    const res = await DELETE(new Request(url('?version=3'), { method: 'DELETE' }), ctx);
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ code, error: `refused: ${code}` });
  });
});

describe('PUT /api/recall/maps/:id/cards/:card', () => {
  const put = async (body: Record<string, unknown>) => {
    const { PUT } = await import('./maps/[id]/cards/[card]/route');
    return PUT(
      new Request(url(), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      ctx,
    );
  };

  it('leaves the sticky fields out when the editor leaves them out', async () => {
    const res = await put({ title: 'Box', bodyMd: 'x', version: 4 });
    expect(res.status).toBe(200);
    const input = h.calls[0]!.args[3] as Record<string, unknown>;
    // Absent, not false or empty: the write keeps the card's own values.
    expect('prompt' in input).toBe(false);
    expect('useWhen' in input).toBe(false);
    expect('options' in input).toBe(false);
    expect(h.calls[0]!.args[5]).toBe(4);
  });

  it('passes an explicit slug change through', async () => {
    await put({ title: 'Box', bodyMd: 'x', slug: 'box-by-box', version: 4 });
    expect(h.calls[0]!.args[3]).toMatchObject({ slug: 'box-by-box' });
  });

  it('refuses a write without a version', async () => {
    const res = await put({ title: 'Box', bodyMd: 'x' });
    expect(res.status).toBe(400);
    expect(h.calls).toHaveLength(0);
  });
});
