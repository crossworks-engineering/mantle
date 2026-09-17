// Pairing codes for QR sign-in (pair-code.ts): 192 random bits stored only as
// a hash, a claim that is one conditional UPDATE (single-use, unexpired,
// unclaimed) minting the same kind-'m' bearer mobile-login mints, and a
// status read scoped to the issuing login. DB mocked with the chainable-stub
// pattern (see mcp-oauth.test.ts); no DB is touched.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

vi.mock('drizzle-orm', () => ({
  and: (...a: unknown[]) => ({ __and: a }),
  eq: (...a: unknown[]) => ({ __eq: a }),
  gt: (...a: unknown[]) => ({ __gt: a }),
  lt: (...a: unknown[]) => ({ __lt: a }),
  isNull: (x: unknown) => ({ __isNull: x }),
}));

const dbState = vi.hoisted(() => ({
  selectResults: [] as unknown[][],
  updateResults: [] as unknown[][],
  inserts: [] as Record<string, unknown>[],
  insertReturning: [] as unknown[][],
  updates: [] as { set: Record<string, unknown>; where: unknown }[],
  deletes: [] as unknown[],
}));

vi.mock('@mantle/db', () => {
  const selectChain = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'limit', 'innerJoin']) chain[m] = () => chain;
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
      returning: () => chain,
      then: (resolve: (v: unknown[]) => void) => resolve(dbState.insertReturning.shift() ?? []),
    };
    return chain;
  };
  const updateChain = () => {
    const entry = { set: {} as Record<string, unknown>, where: undefined as unknown };
    const chain: Record<string, unknown> = {
      set: (v: Record<string, unknown>) => {
        entry.set = v;
        return chain;
      },
      where: (w: unknown) => {
        entry.where = w;
        dbState.updates.push(entry);
        return chain;
      },
      returning: () => chain,
      then: (resolve: (v: unknown[]) => void) => resolve(dbState.updateResults.shift() ?? []),
    };
    return chain;
  };
  const deleteChain = () => {
    const chain: Record<string, unknown> = {
      where: (w: unknown) => {
        dbState.deletes.push(w);
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
    pairingCodes: cols(['id', 'codeHash', 'userId', 'claimedAt', 'claimedDeviceId', 'expiresAt']),
    mobileTokens: cols(['id', 'userId', 'label', 'expiresAt']),
    authUsers: cols(['id', 'email']),
    and: (...a: unknown[]) => ({ __and: a }),
    eq: (...a: unknown[]) => ({ __eq: a }),
    gt: (...a: unknown[]) => ({ __gt: a }),
    lt: (...a: unknown[]) => ({ __lt: a }),
    isNull: (x: unknown) => ({ __isNull: x }),
  };
});

type Mod = typeof import('./pair-code');
let mod: Mod;
let verifyMobileToken: typeof import('./auth').verifyMobileToken;

beforeAll(async () => {
  process.env.SESSION_SECRET = 'test-secret-for-pair-code-at-least-32-chars-long';
  mod = await import('./pair-code');
  ({ verifyMobileToken } = await import('./auth'));
});

beforeEach(() => {
  dbState.selectResults = [];
  dbState.updateResults = [];
  dbState.inserts = [];
  dbState.insertReturning = [];
  dbState.updates = [];
  dbState.deletes = [];
});

describe('the code itself', () => {
  it('is 192 bits of base64url, never repeating', () => {
    const a = mod.generatePairCode();
    const b = mod.generatePairCode();
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(a).not.toBe(b);
  });

  it('hashes with sha256 hex, deterministically', () => {
    expect(mod.hashPairCode('x')).toMatch(/^[0-9a-f]{64}$/);
    expect(mod.hashPairCode('x')).toBe(mod.hashPairCode('x'));
    expect(mod.hashPairCode('x')).not.toBe(mod.hashPairCode('y'));
  });

  it('the QR URL is <brain>/pair with the code in the FRAGMENT, v1', () => {
    expect(mod.pairPayloadUrl('https://brain.example.com/', 'abc_-123')).toBe(
      'https://brain.example.com/pair#v=1&code=abc_-123',
    );
  });
});

describe('issuePairCode', () => {
  it('stores only the hash, bound to the login, with a 90 s expiry, and sweeps stale rows', async () => {
    dbState.insertReturning = [[{ id: 'row-1' }]];
    const now = new Date('2026-09-17T12:00:00Z');
    const issued = await mod.issuePairCode('user-1', now);

    expect(issued.id).toBe('row-1');
    expect(issued.expiresAt.toISOString()).toBe('2026-09-17T12:01:30.000Z');
    expect(dbState.inserts).toHaveLength(1);
    const row = dbState.inserts[0]!;
    expect(row['userId']).toBe('user-1');
    expect(row['codeHash']).toBe(mod.hashPairCode(issued.code));
    expect(JSON.stringify(row)).not.toContain(issued.code);
    expect(dbState.deletes).toHaveLength(1);
  });
});

describe('claimPairCode', () => {
  it('a losing conditional UPDATE (unknown, expired or used) is null and mints nothing', async () => {
    dbState.updateResults = [[]];
    expect(await mod.claimPairCode('nope-nope-nope-nope', 'Phone')).toBeNull();
    expect(dbState.inserts).toHaveLength(0);
    // The one UPDATE carried the single-use guard: hash AND unclaimed AND unexpired.
    expect(JSON.stringify(dbState.updates[0]!.where)).toContain('__isNull');
    expect(JSON.stringify(dbState.updates[0]!.where)).toContain('__gt');
  });

  it('a winning claim mints a kind-m bearer for the issuing login and links the device', async () => {
    dbState.updateResults = [[{ id: 'row-1', userId: 'user-1' }], []];
    dbState.selectResults = [[{ email: 'owner@example.com' }]];
    const claimed = await mod.claimPairCode(
      'the-code-the-code-1234',
      'Jackdaw (Android) · paired by QR',
    );

    expect(claimed).not.toBeNull();
    expect(claimed!.email).toBe('owner@example.com');
    expect(claimed!.userId).toBe('user-1');
    expect(claimed!.label).toBe('Jackdaw (Android) · paired by QR');
    // The bearer verifies as a mobile token for that login with that jti.
    const claims = verifyMobileToken(claimed!.token);
    expect(claims?.uid).toBe('user-1');
    expect(claims?.jti).toBe(claimed!.deviceId);
    // One mobile_tokens row, same shape mobile-login writes.
    expect(dbState.inserts).toHaveLength(1);
    expect(dbState.inserts[0]).toMatchObject({
      id: claimed!.deviceId,
      userId: 'user-1',
      label: 'Jackdaw (Android) · paired by QR',
    });
    // The pairing row now points at the device.
    expect(dbState.updates[1]!.set).toEqual({ claimedDeviceId: claimed!.deviceId });
  });

  it('a missing device name gets the QR default label', async () => {
    dbState.updateResults = [[{ id: 'row-1', userId: 'user-1' }], []];
    dbState.selectResults = [[{ email: 'owner@example.com' }]];
    const claimed = await mod.claimPairCode('the-code-the-code-1234', '   ');
    expect(claimed!.label).toBe('Mobile device (paired by QR)');
  });
});

describe('pairCodeStatus', () => {
  const now = new Date('2026-09-17T12:00:00Z');

  it("unknown (or another login's) id reads as expired", async () => {
    dbState.selectResults = [[]];
    expect(await mod.pairCodeStatus('x', 'user-1', now)).toEqual({
      status: 'expired',
      deviceLabel: null,
    });
  });

  it('pending while unclaimed and unexpired, expired after', async () => {
    dbState.selectResults = [
      [{ claimedAt: null, claimedDeviceId: null, expiresAt: new Date('2026-09-17T12:01:00Z') }],
    ];
    expect((await mod.pairCodeStatus('row-1', 'user-1', now)).status).toBe('pending');
    dbState.selectResults = [
      [{ claimedAt: null, claimedDeviceId: null, expiresAt: new Date('2026-09-17T11:59:00Z') }],
    ];
    expect((await mod.pairCodeStatus('row-1', 'user-1', now)).status).toBe('expired');
  });

  it('claimed carries the device label from mobile_tokens', async () => {
    dbState.selectResults = [
      [{ claimedAt: now, claimedDeviceId: 'jti-1', expiresAt: now }],
      [{ label: 'Jackdaw (Ios) · paired by QR' }],
    ];
    expect(await mod.pairCodeStatus('row-1', 'user-1', now)).toEqual({
      status: 'claimed',
      deviceLabel: 'Jackdaw (Ios) · paired by QR',
    });
  });
});
