/**
 * The admin client storage route (client logins C5 audit, I5) without a
 * database: the content layer is stood in, so these pin the route contract
 * jackdaw builds on. The storage card's total is the box's
 * MANTLE_CLIENT_SPACES_TOTAL_BYTES (5 GB unset), the limits are the client
 * ones, and refusals come through as recorded. Members and clients are
 * refused by getOwnerOr401 (every route in the sweeps). The client comment
 * routes are gone (2026-10-09).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const ACTOR = '55555555-5555-4555-8555-555555555555';
const CLIENT = '12121212-1212-4212-8212-121212121212';

const h = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown[]]>,
  audits: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ({
    id: ANCHOR,
    email: 'admin@example.invalid',
    actor: { id: ACTOR, email: 'admin@example.invalid', displayName: null, isOwner: false },
  })),
}));

vi.mock('@/lib/audit', () => ({
  auditFireAndForget: (a: Record<string, unknown>) => h.audits.push(a),
  requestMetaFrom: () => ({}),
}));

vi.mock('@mantle/content', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/content')>();
  const rec =
    <T>(name: string, ret: () => T) =>
    async (...a: unknown[]) => {
      h.calls.push([name, a]);
      return ret();
    };
  return {
    ...real,
    clientSpacesUsed: rec('clientSpacesUsed', () => 1234),
    clientStorageRows: rec('clientStorageRows', () => [
      {
        loginId: CLIENT,
        name: 'Client',
        usedBytes: 1000,
        uploadedTodayBytes: 10,
        items: 3,
        openSubmissions: 1,
        former: false,
      },
    ]),
    listClientQuotaRefusals: rec('listClientQuotaRefusals', () => [
      { at: '2026-09-29T00:00:00.000Z', loginId: CLIENT, reason: 'total' },
    ]),
    clientAppDbBytes: rec('clientAppDbBytes', () => 4096),
  };
});

beforeEach(() => {
  h.calls.length = 0;
  h.audits.length = 0;
  delete process.env.MANTLE_CLIENT_SPACES_TOTAL_BYTES;
});

describe('GET /api/team-admin/clients/storage', () => {
  it('answers the client limits, the total (env or 5 GB), the rows and the refusals', async () => {
    const { GET } = await import('./storage/route');
    const body = (await (await GET()).json()) as import('@mantle/client-types').ClientStorageUsage;
    expect(body.limits).toEqual({
      fileMaxBytes: 20 * 1024 * 1024,
      perClientBytes: 200 * 1024 * 1024,
      dailyUploadBytes: 50 * 1024 * 1024,
      itemLimit: 500,
      totalBytes: 5 * 1024 * 1024 * 1024,
      submitsPerDay: 10,
      openSubmissions: 50,
    });
    expect(body.totalUsedBytes).toBe(1234);
    expect(body.rows.map((r) => r.loginId)).toEqual([CLIENT]);
    expect(body.refusals).toEqual([
      { at: '2026-09-29T00:00:00.000Z', loginId: CLIENT, reason: 'total' },
    ]);
    expect(h.calls.find(([n]) => n === 'listClientQuotaRefusals')?.[1]).toEqual([50]);
    // What client-level apps' databases hold, for this brain (audit I1).
    expect(body.clientAppDbBytes).toBe(4096);
    expect(h.calls.find(([n]) => n === 'clientAppDbBytes')?.[1]).toEqual([ANCHOR]);
    process.env.MANTLE_CLIENT_SPACES_TOTAL_BYTES = String(8 * 1024 * 1024 * 1024);
    const raised = (await (await GET()).json()) as { limits: { totalBytes: number } };
    expect(raised.limits.totalBytes).toBe(8 * 1024 * 1024 * 1024);
  });
});
