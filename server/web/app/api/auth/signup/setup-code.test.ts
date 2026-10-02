/**
 * The first-run setup code (headless onboarding Phase 1). While auth.users is
 * empty, signup makes its caller the owner; with MANTLE_SETUP_CODE set, only a
 * caller who knows the installer's code may. Unset keeps the old behaviour,
 * and once an account exists the code changes nothing (403 as before).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  users: 0,
  inserts: 0,
  audits: [] as { action: string; detail?: Record<string, unknown> }[],
}));

vi.mock('@mantle/db', () => ({
  countUsers: async () => h.users,
  db: {
    execute: async () => {
      h.inserts += 1;
      return [{ id: 'x' }];
    },
  },
}));
vi.mock('@/lib/audit', () => ({
  auditFireAndForget: (e: { action: string; detail?: Record<string, unknown> }) => h.audits.push(e),
  requestMetaFrom: () => ({}),
}));
vi.mock('bcryptjs', () => ({ default: { hash: async () => 'hash' } }));

const CODE = 'ABCDE-FGHJK-MNPQR-STUVW';
let ipSeq = 0;

function signup(body: Record<string, unknown>, ip = `198.51.100.${++ipSeq}`) {
  return new Request('http://x/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ email: 'first@example.invalid', password: 'long-enough-pw', ...body }),
  });
}

async function load() {
  process.env.SESSION_SECRET ??= 'signup-setup-code-test-secret-at-least-32-chars';
  const { POST } = await import('./route');
  const { GET } = await import('../bootstrap-state/route');
  return { POST, GET };
}

beforeEach(() => {
  h.users = 0;
  h.inserts = 0;
  h.audits = [];
  process.env.MANTLE_SETUP_CODE = CODE;
});
afterEach(() => {
  delete process.env.MANTLE_SETUP_CODE;
});

describe('POST /api/auth/signup with a setup code configured', () => {
  it('refuses a signup with no code: 403 setup-code, nothing inserted, audited', async () => {
    const { POST } = await load();
    const res = await POST(signup({}));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: 'setup-code' });
    expect(h.inserts).toBe(0);
    expect(h.audits).toEqual([
      expect.objectContaining({
        action: 'auth.signup_failed',
        detail: { reason: 'setup-code-missing' },
      }),
    ]);
  });

  it('refuses a wrong code the same way', async () => {
    const { POST } = await load();
    const res = await POST(signup({ setupCode: 'ABCDE-FGHJK-MNPQR-STUVX' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: 'setup-code' });
    expect(h.inserts).toBe(0);
    expect(h.audits[0]).toMatchObject({ detail: { reason: 'setup-code-wrong' } });
  });

  it('accepts the right code and sets the session cookie', async () => {
    const { POST } = await load();
    const res = await POST(signup({ setupCode: CODE }));
    expect(res.status).toBe(200);
    expect(h.inserts).toBe(1);
    expect(res.headers.get('set-cookie')).toMatch(/mantle/i);
    expect(h.audits.map((a) => a.action)).toEqual(['user.create']);
  });

  it('accepts the code as people type it: lowercase, spaces, no dashes', async () => {
    const { POST } = await load();
    const res = await POST(signup({ setupCode: '  abcde fghjk mnpqr stuvw ' }));
    expect(res.status).toBe(200);
    const res2 = await (await load()).POST(signup({ setupCode: 'abcdefghjkmnpqrstuvw' }));
    expect(res2.status).toBe(200);
  });

  it('ignores the code once an account exists: 403 as before, no setup-code reason', async () => {
    h.users = 1;
    const { POST } = await load();
    const res = await POST(signup({ setupCode: CODE }));
    expect(res.status).toBe(403);
    expect((await res.json()).reason).toBeUndefined();
    expect(h.inserts).toBe(0);
  });

  it('rate limits before the compare: the sixth try in a minute is a 429, right code or not', async () => {
    const { POST } = await load();
    const ip = '203.0.113.99';
    for (let i = 0; i < 5; i++) {
      const r = await POST(signup({ setupCode: 'WRONG-WRONG-WRONG-WRONG' }, ip));
      expect(r.status).toBe(403);
    }
    const sixth = await POST(signup({ setupCode: CODE }, ip));
    expect(sixth.status).toBe(429);
    expect(h.inserts).toBe(0);
  });
});

describe('POST /api/auth/signup with no setup code configured', () => {
  it('needs no code (local dev, boxes installed before it)', async () => {
    delete process.env.MANTLE_SETUP_CODE;
    const { POST } = await load();
    const res = await POST(signup({}));
    expect(res.status).toBe(200);
    expect(h.inserts).toBe(1);
  });

  it('treats a blank value as unset', async () => {
    process.env.MANTLE_SETUP_CODE = '  ';
    const { POST } = await load();
    const res = await POST(signup({}));
    expect(res.status).toBe(200);
  });
});

describe('GET /api/auth/bootstrap-state', () => {
  it('says a code is required while the brain is unclaimed', async () => {
    const { GET } = await load();
    expect(await (await GET()).json()).toEqual({ firstRun: true, setupCodeRequired: true });
  });

  it('never asks for a code once claimed', async () => {
    h.users = 1;
    const { GET } = await load();
    expect(await (await GET()).json()).toEqual({ firstRun: false, setupCodeRequired: false });
  });

  it('asks for none when no code is configured', async () => {
    delete process.env.MANTLE_SETUP_CODE;
    const { GET } = await load();
    expect(await (await GET()).json()).toEqual({ firstRun: true, setupCodeRequired: false });
  });
});
