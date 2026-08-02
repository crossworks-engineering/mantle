// Pins the concurrency contract of the refresh_token grant in mcp-oauth.ts.
//
// Several clients legitimately share one connector grant (claude.ai fans a
// connector out to many agents/sessions). The pre-v0.218 in-place rotation
// invalidated both tokens on first refresh, so the SECOND refresher got
// invalid_grant and its connector went silently dead until re-auth. These tests
// pin the fix: a refresh forks a new row, leaves the old access token alone,
// and keeps the used refresh token alive for a short grace window so a
// concurrent refresher forks too instead of dying.
//
// All I/O is mocked with the chainable-db-stub pattern (see push/notify.test.ts);
// no DB is touched.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// drizzle's builders are only argument-carriers for the mocked db.
vi.mock('drizzle-orm', () => ({
  and: (...a: unknown[]) => ({ __and: a }),
  eq: (...a: unknown[]) => ({ __eq: a }),
  gt: (...a: unknown[]) => ({ __gt: a }),
  lt: (...a: unknown[]) => ({ __lt: a }),
  isNull: (x: unknown) => ({ __isNull: x }),
}));

const dbState = vi.hoisted(() => ({
  selectResults: [] as unknown[][],
  inserts: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
  deletes: 0,
  deleteThrows: false,
}));

vi.mock('@mantle/db', () => {
  const selectChain = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'limit']) chain[m] = () => chain;
    chain['then'] = (resolve: (v: unknown[]) => void) =>
      resolve(dbState.selectResults.shift() ?? []);
    return chain;
  };
  const insertChain = () => {
    const chain: Record<string, unknown> = {
      values: (v: Record<string, unknown>) => {
        dbState.inserts.push(v);
        return chain;
      },
      then: (resolve: (v: unknown[]) => void) => resolve([]),
    };
    return chain;
  };
  const updateChain = () => {
    const chain: Record<string, unknown> = {
      set: (v: Record<string, unknown>) => {
        dbState.updates.push(v);
        return chain;
      },
      where: () => chain,
      then: (resolve: (v: unknown[]) => void) => resolve([]),
    };
    return chain;
  };
  const deleteChain = () => {
    const chain: Record<string, unknown> = {
      where: () => {
        if (dbState.deleteThrows) throw new Error('sweep boom');
        dbState.deletes += 1;
        return chain;
      },
      then: (resolve: (v: unknown[]) => void) => resolve([]),
    };
    return chain;
  };
  const cols = (names: string[]) => Object.fromEntries(names.map((n) => [n, `col:${n}`]));
  return {
    db: {
      select: () => selectChain(),
      insert: () => insertChain(),
      update: () => updateChain(),
      delete: () => deleteChain(),
    },
    oauthAccessTokens: cols([
      'id',
      'tokenHash',
      'refreshTokenHash',
      'ownerId',
      'clientId',
      'scope',
      'expiresAt',
      'refreshExpiresAt',
      'lastUsedAt',
      'revokedAt',
      'createdAt',
    ]),
    oauthAuthCodes: cols(['id', 'codeHash', 'clientId', 'expiresAt']),
    oauthClients: cols(['id', 'clientName', 'redirectUris']),
    resolveSingleOwnerId: vi.fn(),
  };
});

vi.mock('@mantle/content', () => ({
  loadProfilePreferences: vi.fn(),
  publicBaseUrl: () => 'https://brain.example.com',
}));
vi.mock('./auth/request', () => ({ bearerFrom: vi.fn() }));

import { refreshAccessToken, REFRESH_GRACE_SEC, ACCESS_TTL_SEC } from './mcp-oauth';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';

function tokenRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'row-1',
    tokenHash: 'oldaccesshash',
    refreshTokenHash: 'oldrefreshhash',
    ownerId: OWNER,
    clientId: CLIENT,
    scope: 'mcp',
    expiresAt: new Date(Date.now() + 30 * 60_000),
    refreshExpiresAt: new Date(Date.now() + 20 * 24 * 3600_000),
    lastUsedAt: null,
    revokedAt: null,
    createdAt: new Date(Date.now() - 3600_000),
    ...overrides,
  };
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dbState.selectResults = [];
  dbState.inserts = [];
  dbState.updates = [];
  dbState.deletes = 0;
  dbState.deleteThrows = false;
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

describe('refreshAccessToken — concurrency-safe rotation', () => {
  it('forks a new row instead of rotating tokens in place', async () => {
    dbState.selectResults = [[tokenRow()]];
    const res = await refreshAccessToken({ refreshToken: 'mtlmcp_rt_old', clientId: CLIENT });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.tokens.access_token).toMatch(/^mtlmcp_at_/);
    expect(res.tokens.refresh_token).toMatch(/^mtlmcp_rt_/);
    expect(res.tokens.expires_in).toBe(ACCESS_TTL_SEC);
    expect(res.tokens.scope).toBe('mcp');

    // The new pair is a brand-new INSERTed row, owned by the same owner+client.
    expect(dbState.inserts).toHaveLength(1);
    expect(dbState.inserts[0]!['ownerId']).toBe(OWNER);
    expect(dbState.inserts[0]!['clientId']).toBe(CLIENT);

    // The old row's access token is NOT invalidated: the update touches only
    // the refresh fuse + lastUsedAt, never tokenHash/expiresAt.
    expect(dbState.updates).toHaveLength(1);
    expect(Object.keys(dbState.updates[0]!).sort()).toEqual(['lastUsedAt', 'refreshExpiresAt']);
  });

  it('puts the used refresh token on the grace fuse (never extends it)', async () => {
    dbState.selectResults = [[tokenRow()]];
    const before = Date.now();
    await refreshAccessToken({ refreshToken: 'mtlmcp_rt_old', clientId: CLIENT });

    const fuse = dbState.updates[0]!['refreshExpiresAt'] as Date;
    const graceMs = REFRESH_GRACE_SEC * 1000;
    expect(fuse.getTime()).toBeGreaterThanOrEqual(before + graceMs - 1000);
    expect(fuse.getTime()).toBeLessThanOrEqual(Date.now() + graceMs + 1000);
  });

  it('keeps a shorter remaining life instead of extending to the grace window', async () => {
    const soon = new Date(Date.now() + 30_000); // 30 s left < 120 s grace
    dbState.selectResults = [[tokenRow({ refreshExpiresAt: soon })]];
    await refreshAccessToken({ refreshToken: 'mtlmcp_rt_old', clientId: CLIENT });

    expect(dbState.updates[0]!['refreshExpiresAt']).toBe(soon);
  });

  it('a concurrent second refresh within the grace window forks its own row', async () => {
    // Row as the second refresher would find it: fuse lit, not yet expired.
    const inGrace = tokenRow({
      refreshExpiresAt: new Date(Date.now() + (REFRESH_GRACE_SEC - 1) * 1000),
      lastUsedAt: new Date(),
    });
    dbState.selectResults = [[inGrace]];
    const res = await refreshAccessToken({ refreshToken: 'mtlmcp_rt_old', clientId: CLIENT });

    expect(res.ok).toBe(true);
    expect(dbState.inserts).toHaveLength(1); // its own fork, not invalid_grant
  });

  it('rejects the refresh token after the grace window (and logs it)', async () => {
    dbState.selectResults = [[tokenRow({ refreshExpiresAt: new Date(Date.now() - 1000) })]];
    const res = await refreshAccessToken({ refreshToken: 'mtlmcp_rt_old', clientId: CLIENT });

    expect(res).toEqual({ ok: false, error: 'invalid_grant' });
    expect(dbState.inserts).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toContain(CLIENT);
  });

  it('rejects an unknown refresh token (and logs it)', async () => {
    dbState.selectResults = [[]];
    const res = await refreshAccessToken({ refreshToken: 'mtlmcp_rt_nope', clientId: CLIENT });

    expect(res).toEqual({ ok: false, error: 'invalid_grant' });
    expect(warn).toHaveBeenCalledOnce();
  });

  it('rejects a client mismatch', async () => {
    dbState.selectResults = [[tokenRow({ clientId: 'someone-else' })]];
    const res = await refreshAccessToken({ refreshToken: 'mtlmcp_rt_old', clientId: CLIENT });

    expect(res).toEqual({ ok: false, error: 'invalid_grant' });
    expect(dbState.inserts).toHaveLength(0);
  });

  it('sweeps fully-dead rows, and a failed sweep does not fail the grant', async () => {
    dbState.selectResults = [[tokenRow()]];
    await refreshAccessToken({ refreshToken: 'mtlmcp_rt_old', clientId: CLIENT });
    expect(dbState.deletes).toBe(1);

    dbState.selectResults = [[tokenRow()]];
    dbState.deleteThrows = true;
    const res = await refreshAccessToken({ refreshToken: 'mtlmcp_rt_old', clientId: CLIENT });
    expect(res.ok).toBe(true);
  });
});
