// POST /api/auth/pair/claim (QR sign-in): the answer keeps the shape shipped
// builds read (the mobile-login shape plus `email`) and, since contract
// v1.1, also names the login and this brain, the pair a device holding
// several logins files the session under. The code store and the database
// are stand-ins; the claim itself is tested in lib/pair-code.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  claimed: null as null | {
    userId: string;
    email: string;
    token: string;
    expiresIn: number;
    expiresAt: Date;
    deviceId: string;
    label: string;
  },
}));

vi.mock('@mantle/db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['set', 'where']) chain[m] = () => chain;
  chain['then'] = (resolve: (v: unknown) => void) => resolve([]);
  return {
    db: { update: () => chain },
    authUsers: { id: 'id', lastLoginAt: 'last_login_at' },
    eq: () => ({}),
    sql: () => ({}),
  };
});
vi.mock('@/lib/pair-code', () => ({ claimPairCode: async () => h.claimed }));
vi.mock('@/lib/audit', () => ({ auditFireAndForget: vi.fn(), requestMetaFrom: () => ({}) }));
vi.mock('@/lib/rate-limit', () => ({
  clientIp: () => '1.1.1.1',
  clientIpKey: () => '1.1.1.1',
  rateLimit: () => ({ ok: true }),
}));
vi.mock('@/lib/brain-identity', () => ({
  brainIdField: async () => ({ brainId: '0b7c6a1e-2f4d-4c1a-9e8b-5d3f2a1c0e9f' }),
}));

import { POST } from './route';

const claim = () =>
  POST(
    new Request('https://brain.example.com/api/auth/pair/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'a'.repeat(32), deviceName: 'Phone' }),
    }),
  );

beforeEach(() => {
  h.claimed = null;
});

describe('POST /api/auth/pair/claim', () => {
  it('answers the shipped shape plus the login and this brain', async () => {
    h.claimed = {
      userId: 'login-admin',
      email: 'admin@example.invalid',
      token: 'tok',
      expiresIn: 60,
      expiresAt: new Date('2027-01-01T00:00:00Z'),
      deviceId: 'dev-1',
      label: 'Phone',
    };
    const res = await claim();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      token: 'tok',
      expiresIn: 60,
      expiresAt: '2027-01-01T00:00:00.000Z',
      deviceId: 'dev-1',
      email: 'admin@example.invalid',
      loginId: 'login-admin',
      brainId: '0b7c6a1e-2f4d-4c1a-9e8b-5d3f2a1c0e9f',
    });
  });

  it('a code that does not work names nothing', async () => {
    const res = await claim();
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['error']);
  });
});
