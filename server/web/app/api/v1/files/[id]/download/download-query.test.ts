import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * GET /api/v1/files/:id/download hands the bytes handler the query the
 * gate answers its asset reader from (A4 hand batch B fix round 1, L1): the
 * real route file, with the bytes handler stood in to see what it is
 * handed.
 */
const handed: Request[] = [];
vi.mock('../../../../files/files/[id]/route', () => ({
  GET: async (req: Request) => {
    handed.push(req);
    return new Response('bytes');
  },
}));

afterEach(() => {
  handed.length = 0;
});

describe('the v1 download hands its query from the one constant', () => {
  it("drops the query sent (an Admin user's ?at= among it) for the asset row's own", async () => {
    const { ASSET_QUERY_AS_HANDED, V1_DOWNLOAD_QUERY, assetQueryAsHanded } =
      await import('@/lib/auth/route-policy');
    const { GET } = await import('./route');
    const id = '11111111-1111-4111-8111-111111111111';
    const sent = new Request(
      `http://brain.test/api/v1/files/${id}/download?at=admin-token&raw=0&x=1`,
      { headers: { authorization: 'Bearer member-session' } },
    );
    const res = await GET(sent, { params: Promise.resolve({ id }) });
    expect(await res.text()).toBe('bytes');
    expect(handed).toHaveLength(1);
    const url = new URL(handed[0]!.url);
    // What the gate answered the asset reader from is what the handler got.
    const query = assetQueryAsHanded({ method: 'GET', pattern: '/api/v1/files/:id/download' });
    expect(url.search).toBe(query);
    expect(url.search).toBe(V1_DOWNLOAD_QUERY);
    expect(url.searchParams.get('at')).toBeNull();
    expect(url.pathname).toBe(`/api/v1/files/${id}/download`);
    expect(handed[0]!.headers.get('authorization')).toBe('Bearer member-session');
    // HEAD takes its GET's.
    expect(assetQueryAsHanded({ method: 'HEAD', pattern: '/api/v1/files/:id/download' })).toBe(
      query,
    );
    // The one row that hands another query.
    expect([...ASSET_QUERY_AS_HANDED.keys()]).toEqual(['GET /api/v1/files/:id/download']);
  });
});
