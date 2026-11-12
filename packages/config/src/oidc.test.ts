/**
 * The password hold under company sign-in (oidc.ts passwordHoldFor), row
 * by row, and the way-in rule it reads (passwordIsWayIn).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertEnvShape, oidcModeWord, parseOidcMode } from './index';
import {
  oidcNames,
  oidcRowNamesNeeded,
  oidcSettingsFor,
  setOidcRowNames,
  passwordHoldFor,
  passwordIsWayIn,
  readOidcSettings,
  type CredentialKind,
  type PasswordHold,
} from './oidc';

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

describe('the mode word `setup`', () => {
  afterEach(() => vi.unstubAllEnvs());

  const shape = (): string => {
    try {
      assertEnvShape();
      return '';
    } catch (err) {
      return (err as Error).message;
    }
  };
  const base = () => {
    vi.stubEnv('SESSION_SECRET', 'x'.repeat(48));
    vi.stubEnv('MANTLE_OIDC_ISSUER', '');
    vi.stubEnv('MANTLE_OIDC_CLIENT_ID', '');
    vi.stubEnv('MANTLE_PUBLIC_URL', '');
    vi.stubEnv('MANTLE_OIDC_OUTSIDE', '');
  };

  it('reads off in every gate, and as itself only in oidcModeWord', () => {
    vi.stubEnv('MANTLE_OIDC_MODE', 'Setup');
    vi.stubEnv('MANTLE_OIDC_ISSUER', 'https://idp.example.invalid');
    vi.stubEnv('MANTLE_OIDC_CLIENT_ID', 'mantle');
    vi.stubEnv('MANTLE_PUBLIC_URL', 'https://brain.example.invalid');
    expect(parseOidcMode('setup')).toBe('off');
    expect(readOidcSettings()).toEqual({ settings: { mode: 'off' }, problem: null });
    expect(oidcModeWord()).toBe('setup');
    // What the lock will apply.
    const { settings } = oidcSettingsFor('optional');
    expect(settings.mode).toBe('optional');
  });

  it.each([
    [undefined, 'off'],
    ['off', 'off'],
    ['on', 'optional'],
    ['required', 'required'],
    ['requird', 'off'],
  ])('oidcModeWord of %j is %s', (raw, want) => {
    vi.stubEnv('MANTLE_OIDC_MODE', raw as string);
    expect(oidcModeWord()).toBe(want);
  });

  it('a boot in setup may miss a line: the screen names it', () => {
    base();
    vi.stubEnv('MANTLE_OIDC_MODE', 'setup');
    expect(shape()).not.toContain('MANTLE_OIDC');
    expect(shape()).not.toContain('MANTLE_PUBLIC_URL');
  });

  it.each([
    ['MANTLE_OIDC_OUTSIDE', 'maybe', 'MANTLE_OIDC_OUTSIDE must be on or off'],
    ['MANTLE_OIDC_ISSUER', 'ftp://idp', 'MANTLE_OIDC_ISSUER must start with https://'],
    [
      'MANTLE_OIDC_ISSUER',
      'http://idp.example.invalid',
      'must use https when MANTLE_OIDC_MODE is setup',
    ],
    [
      'MANTLE_PUBLIC_URL',
      'not a url',
      'MANTLE_PUBLIC_URL must be a URL when MANTLE_OIDC_MODE is setup',
    ],
    [
      'MANTLE_PUBLIC_URL',
      'http://brain.example.invalid',
      'must use https when MANTLE_OIDC_MODE is setup',
    ],
  ])('a boot in setup stops on a bad %s', (name, value, text) => {
    base();
    vi.stubEnv('MANTLE_OIDC_MODE', 'setup');
    vi.stubEnv(name, value);
    expect(shape()).toContain(text);
  });

  it('a boot in setup allows http to a loopback test provider', () => {
    base();
    vi.stubEnv('MANTLE_OIDC_MODE', 'setup');
    vi.stubEnv('MANTLE_OIDC_ISSUER', 'http://127.0.0.1:8180/realms/test');
    expect(shape()).not.toContain('MANTLE_OIDC_ISSUER');
  });

  it('a typo still stops the boot, and names setup', () => {
    base();
    vi.stubEnv('MANTLE_OIDC_MODE', 'setpu');
    expect(shape()).toContain('MANTLE_OIDC_MODE must be off, setup, optional or required');
  });

  it('required without a public URL stops the boot; the issuer and client id may come from the row', () => {
    base();
    vi.stubEnv('MANTLE_OIDC_MODE', 'required');
    expect(shape()).toContain('MANTLE_PUBLIC_URL must be set when MANTLE_OIDC_MODE is required');
    expect(shape()).not.toContain('MANTLE_OIDC_ISSUER');
    expect(shape()).not.toContain('MANTLE_OIDC_CLIENT_ID');
  });
});

describe('the row names (0371): a .env line wins, value by value', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    setOidcRowNames({});
  });
  const ROW_ISSUER = 'https://login.microsoftonline.com/11111111-2222-4333-8444-555555555555/v2.0';

  it('the row fills what the .env leaves blank, and each value names its source', () => {
    vi.stubEnv('MANTLE_OIDC_MODE', 'optional');
    vi.stubEnv('MANTLE_OIDC_ISSUER', '');
    vi.stubEnv('MANTLE_OIDC_CLIENT_ID', '');
    vi.stubEnv('MANTLE_PUBLIC_URL', 'https://brain.example.invalid');
    expect(oidcNames()).toMatchObject({ issuerFrom: 'none', clientIdFrom: 'none' });
    expect(readOidcSettings().settings.mode).toBe('off');
    setOidcRowNames({ issuer: ROW_ISSUER, clientId: 'row-client' });
    expect(oidcNames()).toEqual({
      issuer: ROW_ISSUER,
      clientId: 'row-client',
      issuerFrom: 'row',
      clientIdFrom: 'row',
    });
    expect(readOidcSettings().settings).toMatchObject({
      mode: 'optional',
      issuer: ROW_ISSUER,
      clientId: 'row-client',
    });
    vi.stubEnv('MANTLE_OIDC_CLIENT_ID', 'env-client');
    expect(oidcNames()).toMatchObject({
      issuer: ROW_ISSUER,
      issuerFrom: 'row',
      clientId: 'env-client',
      clientIdFrom: 'env',
    });
    vi.stubEnv('MANTLE_OIDC_ISSUER', 'https://idp.example.invalid/r');
    expect(oidcNames()).toMatchObject({
      issuer: 'https://idp.example.invalid/r',
      issuerFrom: 'env',
    });
  });

  it('the boot reads the row only with the mode word on or setup and a .env name missing', () => {
    vi.stubEnv('MANTLE_OIDC_ISSUER', '');
    vi.stubEnv('MANTLE_OIDC_CLIENT_ID', '');
    vi.stubEnv('MANTLE_OIDC_MODE', 'off');
    expect(oidcRowNamesNeeded()).toBe(false);
    for (const mode of ['setup', 'optional', 'required']) {
      vi.stubEnv('MANTLE_OIDC_MODE', mode);
      expect(oidcRowNamesNeeded(), mode).toBe(true);
    }
    vi.stubEnv('MANTLE_OIDC_ISSUER', 'https://idp.example.invalid/r');
    expect(oidcRowNamesNeeded()).toBe(true);
    vi.stubEnv('MANTLE_OIDC_CLIENT_ID', 'mantle');
    expect(oidcRowNamesNeeded()).toBe(false);
  });

  it('setup still reads off in every gate, whatever the row holds', () => {
    vi.stubEnv('MANTLE_OIDC_MODE', 'setup');
    vi.stubEnv('MANTLE_PUBLIC_URL', 'https://brain.example.invalid');
    setOidcRowNames({ issuer: ROW_ISSUER, clientId: 'row-client' });
    expect(readOidcSettings().settings).toEqual({ mode: 'off' });
  });
});
