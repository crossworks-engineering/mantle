/**
 * The password hold under company sign-in (oidc.ts passwordHoldFor), row
 * by row, and the way-in rule it reads (passwordIsWayIn).
 */
import { describe, expect, it } from 'vitest';
import { passwordHoldFor, passwordIsWayIn, type CredentialKind, type PasswordHold } from './oidc';

describe('passwordIsWayIn', () => {
  it('only required mode takes a linked login password away, never the anchor', () => {
    for (const mode of ['off', 'optional'] as const) {
      expect(passwordIsWayIn(mode, { owner: false, linked: true })).toBe(true);
    }
    expect(passwordIsWayIn('required', { owner: false, linked: true })).toBe(false);
    expect(passwordIsWayIn('required', { owner: true, linked: true })).toBe(true);
    expect(passwordIsWayIn('required', { owner: false, linked: false })).toBe(true);
  });
});

describe('passwordHoldFor', () => {
  const kinds: CredentialKind[] = ['password', 'sso', 'grant'];
  const holds: PasswordHold[] = ['change', 'recheck', null];

  it('no hold, or a password that is no way in: nothing, whatever the credential', () => {
    for (const kind of kinds) {
      expect(passwordHoldFor(null, kind, { passwordWayIn: true, companyWayIn: false })).toBeNull();
      for (const hold of holds) {
        for (const companyWayIn of [false, true]) {
          expect(passwordHoldFor(hold, kind, { passwordWayIn: false, companyWayIn })).toBeNull();
        }
      }
    }
  });

  it('change holds every credential while the password is a way in', () => {
    for (const kind of kinds) {
      for (const companyWayIn of [false, true]) {
        expect(passwordHoldFor('change', kind, { passwordWayIn: true, companyWayIn })).toBe(
          'change',
        );
      }
    }
  });

  it('recheck: a password session always, an SSO session never, a grant without a company way in', () => {
    const at = (kind: CredentialKind, companyWayIn: boolean) =>
      passwordHoldFor('recheck', kind, { passwordWayIn: true, companyWayIn });
    expect(at('password', false)).toBe('recheck');
    expect(at('password', true)).toBe('recheck');
    expect(at('sso', false)).toBeNull();
    expect(at('sso', true)).toBeNull();
    expect(at('grant', false)).toBe('recheck');
    expect(at('grant', true)).toBeNull();
  });
});
