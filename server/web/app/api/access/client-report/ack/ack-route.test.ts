/**
 * POST /api/access/client-report/ack without a database (audit A7): the
 * body is a fingerprint (preferred) or the old itemIds list; a fingerprint
 * that no longer matches is a 409 `report-changed` so the client reloads.
 * The acknowledgement logic itself is pinned by client-report.db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const ACTOR = '55555555-5555-4555-8555-555555555555';
const ITEM = '12121212-1212-4212-8212-121212121212';
const FP = 'a'.repeat(64);

const h = vi.hoisted(() => ({ seen: [] as unknown[], changed: false }));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ({
    id: ANCHOR,
    email: 'admin@example.invalid',
    actor: { id: ACTOR, email: 'admin@example.invalid', displayName: null, isOwner: false },
  })),
}));

vi.mock('@mantle/content', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/content')>();
  return {
    ...real,
    acknowledgeClientReport: vi.fn(async (_o: string, _l: string, seen: unknown) => {
      h.seen.push(seen);
      if (h.changed) throw new real.ClientReportChangedError();
      return {
        acknowledgement: { ackedAt: '2026-09-29T00:00:00.000Z', ackedBy: null, itemCount: 1 },
        acknowledged: true,
      };
    }),
  };
});

beforeEach(() => {
  h.seen = [];
  h.changed = false;
});

const post = async (body: unknown) => {
  const { POST } = await import('./route');
  return POST(
    new Request('https://brain.example.invalid/api/access/client-report/ack', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
};

describe('POST /api/access/client-report/ack', () => {
  it('takes a fingerprint and hands it on as one', async () => {
    const res = await post({ fingerprint: FP });
    expect(res.status).toBe(200);
    expect(h.seen).toEqual([{ fingerprint: FP }]);
  });

  it('still takes the old itemIds list', async () => {
    const res = await post({ itemIds: [ITEM] });
    expect(res.status).toBe(200);
    expect(h.seen).toEqual([[ITEM]]);
  });

  it('a stale fingerprint is a 409 report-changed', async () => {
    h.changed = true;
    const res = await post({ fingerprint: FP });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'conflict', reason: 'report-changed' });
  });

  it('refuses a body with neither, or a fingerprint that is not sha256 hex', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ fingerprint: 'nope' })).status).toBe(400);
    expect(h.seen).toEqual([]);
  });
});
