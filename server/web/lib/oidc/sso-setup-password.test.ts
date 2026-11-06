/**
 * The password step of the setup screen's two writes (flow.ts
 * ssoSetupPasswordRefusal), with the password check stood in: each answer, and
 * the login's own failure budget, as at a link start. The box password rule is
 * read once at boot, so its real hold is proved in password-hold.db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  answer: 'ok' as 'ok' | 'wrong' | 'held',
  audits: [] as Record<string, unknown>[],
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  verifyPasswordForUse: async () => h.answer,
}));
vi.mock('@/lib/audit', () => ({
  auditFireAndForget: (row: Record<string, unknown>) => h.audits.push(row),
  requestMetaFrom: () => ({}),
}));

const { ssoSetupPasswordRefusal } = await import('./flow');
const { passwordChangeRequiredBody } = await import('@/lib/auth/password-hold');

const req = () =>
  new Request('https://brain.example.invalid/api/users/sso-setup', { method: 'PUT' });
let n = 0;
const actor = () => ({
  id: `00000000-0000-4000-8000-${String((n += 1)).padStart(12, '0')}`,
  email: 'a@example.invalid',
});

beforeEach(() => {
  h.answer = 'ok';
  h.audits = [];
});

describe('the password step', () => {
  it('a right password passes', async () => {
    expect(await ssoSetupPasswordRefusal(req(), actor(), 'pw')).toBeNull();
    expect(h.audits).toEqual([]);
  });

  it('a wrong one answers 403 password, and writes the failed sign-in row', async () => {
    h.answer = 'wrong';
    const res = await ssoSetupPasswordRefusal(req(), actor(), 'the-typed-password');
    expect(res!.status).toBe(403);
    const text = await res!.text();
    expect(JSON.parse(text)).toMatchObject({ code: 'password' });
    expect(text).not.toContain('the-typed-password');
    expect(h.audits).toEqual([
      expect.objectContaining({
        action: 'auth.login_failed',
        method: 'PUT',
        path: '/api/users/sso-setup',
        detail: { channel: 'sso-setup', reason: 'password' },
      }),
    ]);
    expect(JSON.stringify(h.audits)).not.toContain('the-typed-password');
  });

  it('a right password that fails the box rule answers the hold: never a pass, never wrong', async () => {
    h.answer = 'held';
    const res = await ssoSetupPasswordRefusal(req(), actor(), 'pw');
    expect(res!.status).toBe(403);
    expect(await res!.json()).toEqual(passwordChangeRequiredBody());
    expect(h.audits).toEqual([]);
  });

  it('the budget: 5 wrong tries, then 429; a right one gives its try back', async () => {
    const who = actor();
    h.answer = 'ok';
    for (let i = 0; i < 8; i++) {
      expect(await ssoSetupPasswordRefusal(req(), who, 'pw')).toBeNull();
    }
    h.answer = 'wrong';
    for (let i = 0; i < 5; i++) {
      expect((await ssoSetupPasswordRefusal(req(), who, 'pw'))!.status).toBe(403);
    }
    expect((await ssoSetupPasswordRefusal(req(), who, 'pw'))!.status).toBe(429);
    // Another login's budget is its own.
    expect((await ssoSetupPasswordRefusal(req(), actor(), 'pw'))!.status).toBe(403);
  });
});
