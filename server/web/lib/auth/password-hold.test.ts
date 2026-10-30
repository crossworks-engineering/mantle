/**
 * The password hold (docs/policy.md): under a password rule, a login whose
 * flag is set reaches only the change-password step; with no rule the hold
 * reads nothing at all, so every request runs as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetBoxPolicyForTests } from '@mantle/config';
import type { RequestLogins } from './session';
import { PASSWORD_CHANGE_REQUIRED, PASSWORD_HOLD_OPEN, passwordHoldAnswer } from './password-hold';

function logins(found: Promise<unknown>) {
  return {
    login: vi.fn(() => found),
    keepFailure: vi.fn(),
  } as unknown as RequestLogins & {
    login: ReturnType<typeof vi.fn>;
    keepFailure: ReturnType<typeof vi.fn>;
  };
}
const held = () => logins(Promise.resolve({ resolved: { mustChangePassword: true } }));
const free = () => logins(Promise.resolve({ resolved: { mustChangePassword: false } }));

const saved = process.env.MANTLE_POLICY_PASSWORD_MIN;
function policyMin(v: string | undefined): void {
  if (v === undefined) delete process.env.MANTLE_POLICY_PASSWORD_MIN;
  else process.env.MANTLE_POLICY_PASSWORD_MIN = v;
  resetBoxPolicyForTests();
}
beforeEach(() => policyMin(undefined));
afterEach(() => policyMin(saved));

describe('no password rule', () => {
  it('never reads the login and never holds', async () => {
    const l = held();
    expect(await passwordHoldAnswer({ key: 'GET /api/pages' }, l)).toBeNull();
    expect(l.login).not.toHaveBeenCalled();
  });
});

describe('MANTLE_POLICY_PASSWORD_MIN set', () => {
  beforeEach(() => policyMin('12'));

  it('holds a flagged login on every other route, with the coded 403', async () => {
    const res = await passwordHoldAnswer({ key: 'GET /api/pages' }, held());
    expect(res?.status).toBe(403);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      error: PASSWORD_CHANGE_REQUIRED,
      code: PASSWORD_CHANGE_REQUIRED,
      min: 12,
      commonList: true,
    });
  });

  it('lets a flagged login reach the change step, whoami and sign-out', async () => {
    for (const key of PASSWORD_HOLD_OPEN) {
      expect(await passwordHoldAnswer({ key }, held()), key).toBeNull();
    }
    expect(PASSWORD_HOLD_OPEN.has('POST /api/auth/change-password')).toBe(true);
    expect(PASSWORD_HOLD_OPEN.has('POST /api/access-keys')).toBe(false);
    expect(PASSWORD_HOLD_OPEN.has('POST /api/oauth/authorize')).toBe(false);
  });

  it('lets an unflagged login and no login through', async () => {
    expect(await passwordHoldAnswer({ key: 'GET /api/pages' }, free())).toBeNull();
    const none = logins(Promise.resolve({ resolved: null }));
    expect(await passwordHoldAnswer({ key: 'GET /api/pages' }, none)).toBeNull();
  });

  it('keeps a failed find for the guard, which answers that failure', async () => {
    const failing = Promise.reject(new Error('database down'));
    failing.catch(() => {});
    const l = logins(failing);
    expect(await passwordHoldAnswer({ key: 'GET /api/pages' }, l)).toBeNull();
    expect(l.keepFailure).toHaveBeenCalledWith(failing);
  });
});
