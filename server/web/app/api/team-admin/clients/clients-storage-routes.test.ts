/**
 * The admin client storage and comment routes (client logins C5 audit, I5
 * and U2) without a database: the content layer is stood in, so these pin
 * the route contract jackdaw builds on. The storage card's total is the
 * box's MANTLE_CLIENT_SPACES_TOTAL_BYTES (5 GB unset), the limits are the
 * client ones, and refusals come through as recorded; the comment activity
 * takes 1 to 90 days; delete-all names the client and the brain and is
 * audited. Members and clients are refused by getOwnerOr401 (every route in
 * the sweeps).
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
    clientThreadActivity: rec('clientThreadActivity', () => []),
    clientAppDbBytes: rec('clientAppDbBytes', () => 4096),
    deleteClientComments: rec('deleteClientComments', () => 7),
  };
});

beforeEach(() => {
  h.calls.length = 0;
  h.audits.length = 0;
  delete process.env.MANTLE_CLIENT_SPACES_TOTAL_BYTES;
});

const req = (url: string, method = 'GET') => new Request(`http://x${url}`, { method });

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

describe('GET /api/team-admin/clients/comments', () => {
  it('takes 1 to 90 days (default 7) and reads this brain', async () => {
    const { GET } = await import('./comments/route');
    expect((await GET(req('/api/team-admin/clients/comments'))).status).toBe(200);
    expect((await GET(req('/api/team-admin/clients/comments?days=30'))).status).toBe(200);
    for (const bad of ['0', '91', 'week']) {
      expect((await GET(req(`/api/team-admin/clients/comments?days=${bad}`))).status, bad).toBe(
        400,
      );
    }
    expect(h.calls.filter(([n]) => n === 'clientThreadActivity').map(([, a]) => a)).toEqual([
      [ANCHOR, 7],
      [ANCHOR, 30],
    ]);
  });
});

describe('DELETE /api/team-admin/clients/:id/comments', () => {
  it('deletes that client’s comments on this brain, answers the count, and audits it', async () => {
    const { DELETE } = await import('./[id]/comments/route');
    const res = await DELETE(req(`/api/team-admin/clients/${CLIENT}/comments`, 'DELETE'), {
      params: Promise.resolve({ id: CLIENT }),
    });
    expect(await res.json()).toEqual({ deleted: 7 });
    expect(h.calls.find(([n]) => n === 'deleteClientComments')?.[1]).toEqual([ANCHOR, CLIENT]);
    expect(h.audits).toMatchObject([
      {
        actorId: ACTOR,
        action: 'client.comments_deleted',
        detail: { targetId: CLIENT, deleted: 7 },
      },
    ]);
    const bad = await DELETE(req('/api/team-admin/clients/x/comments', 'DELETE'), {
      params: Promise.resolve({ id: 'x' }),
    });
    expect(bad.status).toBe(404);
    expect(h.calls.filter(([n]) => n === 'deleteClientComments').length).toBe(1);
  });
});
