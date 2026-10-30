/**
 * The password hold (docs/policy.md): under a password rule, a login whose
 * flag is set reaches only the rows that declare `passwordHold:
 * 'change-step'` or 'sign-out'; a login not yet checked under the rule
 * answers as signed out on every row but sign-out; a public row that acts
 * as no login (sign-in) is never held. With no rule the hold reads nothing
 * at all, so every request runs as before.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetBoxPolicyForTests } from '@mantle/config';
import { buildRoutePolicy, type RouteRow } from './route-policy';
import type { RequestLogins } from './session';
import {
  PASSWORD_CHANGE_REQUIRED,
  PASSWORD_RECHECK_REQUIRED,
  passwordHoldAnswer,
} from './password-hold';

function logins(found: Promise<unknown>) {
  return {
    login: vi.fn(() => found),
    keepFailure: vi.fn(),
  } as unknown as RequestLogins & {
    login: ReturnType<typeof vi.fn>;
    keepFailure: ReturnType<typeof vi.fn>;
  };
}
const as = (mustChangePassword: boolean, passwordCheckedMin: number | null) =>
  logins(Promise.resolve({ resolved: { mustChangePassword, passwordCheckedMin } }));
const held = () => as(true, 12);
const unchecked = () => as(false, null);
const free = () => as(false, 12);

/** The live route table, from the generated manifest (the route files'
 *  own declarations). */
let ROUTE_POLICY: ReadonlyMap<string, RouteRow>;
beforeAll(async () => {
  ROUTE_POLICY = buildRoutePolicy((await import('../../server/route-manifest.gen')).routeManifest);
});

function row(key: string) {
  const r = ROUTE_POLICY.get(key);
  expect(r, key).toBeDefined();
  return r!;
}

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
    expect(await passwordHoldAnswer(row('GET /api/shell'), l)).toBeNull();
    expect(l.login).not.toHaveBeenCalled();
  });
});

describe('MANTLE_POLICY_PASSWORD_MIN set', () => {
  beforeEach(() => policyMin('12'));

  it('a flagged login: the coded 403 on every row but its declared ones', async () => {
    const res = await passwordHoldAnswer(row('GET /api/shell'), held());
    expect(res?.status).toBe(403);
    expect(await res!.json()).toMatchObject({
      error: PASSWORD_CHANGE_REQUIRED,
      code: PASSWORD_CHANGE_REQUIRED,
      min: 12,
      commonList: true,
    });
    for (const key of [
      'POST /api/auth/change-password',
      'GET /api/auth/whoami',
      'POST /api/auth/logout',
      'POST /api/auth/sso',
    ]) {
      expect(await passwordHoldAnswer(row(key), held()), key).toBeNull();
    }
    // What would mint a credential is held.
    for (const key of ['POST /api/access-keys', 'POST /api/auth/pair']) {
      expect((await passwordHoldAnswer(row(key), held()))?.status, key).toBe(403);
    }
  });

  it('a login never checked under the rule answers as signed out, but signs out', async () => {
    for (const key of [
      'GET /api/shell',
      'GET /api/auth/whoami',
      'POST /api/auth/change-password',
    ]) {
      const res = await passwordHoldAnswer(row(key), unchecked());
      expect(res?.status, key).toBe(401);
      expect(await res!.json()).toMatchObject({ code: PASSWORD_RECHECK_REQUIRED });
    }
    expect(await passwordHoldAnswer(row('POST /api/auth/logout'), unchecked())).toBeNull();
  });

  it('the sign-in rows act as no login: never held, the login not read', async () => {
    for (const key of [
      'POST /api/auth/login',
      'POST /api/auth/device-login',
      'POST /api/auth/token',
      'GET /api/auth/bootstrap-state',
    ]) {
      const l = held();
      expect(await passwordHoldAnswer(row(key), l), key).toBeNull();
      expect(l.login, key).not.toHaveBeenCalled();
    }
  });

  it('lets an unflagged, checked login and no login through', async () => {
    expect(await passwordHoldAnswer(row('GET /api/shell'), free())).toBeNull();
    const none = logins(Promise.resolve({ resolved: null }));
    expect(await passwordHoldAnswer(row('GET /api/shell'), none)).toBeNull();
  });

  it('keeps a failed find for the guard, which answers that failure', async () => {
    const failing = Promise.reject(new Error('database down'));
    failing.catch(() => {});
    const l = logins(failing);
    expect(await passwordHoldAnswer(row('GET /api/shell'), l)).toBeNull();
    expect(l.keepFailure).toHaveBeenCalledWith(failing);
  });
});

describe('the rows that declare passwordHold', () => {
  it('are the change step, whoami, sign-out and keeping a session, nothing else', () => {
    const open = [...ROUTE_POLICY.values()]
      .filter((r) => r.passwordHold !== null)
      .map((r) => `${r.key} ${r.passwordHold}`)
      .sort();
    expect(open).toEqual(
      [
        'GET /api/auth/whoami change-step',
        'HEAD /api/auth/whoami change-step',
        'POST /api/auth/change-password change-step',
        'POST /api/auth/logout sign-out',
        'POST /api/auth/mobile-logout sign-out',
        'POST /api/auth/sso change-step',
        'POST /api/auth/token/refresh change-step',
      ].sort(),
    );
  });
});
