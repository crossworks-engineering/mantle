/**
 * The one cross-origin allowlist (corsAllowlist): the box's
 * MANTLE_API_CORS_ORIGINS plus the desktop app's page origin, which every box
 * trusts with no setting. The gate's CORS and the login-CSRF guard both read
 * it, so a change here moves both.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DESKTOP_APP_ORIGINS, corsAllowlist, namedCorsOrigins } from './preflight';

const DESKTOP = 'mantle-ui://localhost';

const saved = process.env.MANTLE_API_CORS_ORIGINS;
beforeEach(() => {
  delete process.env.MANTLE_API_CORS_ORIGINS;
});
afterEach(() => {
  if (saved === undefined) delete process.env.MANTLE_API_CORS_ORIGINS;
  else process.env.MANTLE_API_CORS_ORIGINS = saved;
});

describe('corsAllowlist', () => {
  it('names the desktop app origin exactly, and only it', () => {
    expect(DESKTOP_APP_ORIGINS).toEqual([DESKTOP]);
  });

  it('holds the desktop origin with nothing set', () => {
    expect(corsAllowlist()).toEqual([DESKTOP]);
    expect(namedCorsOrigins()).toEqual([DESKTOP]);
  });

  it('adds the env entries, trimmed, without a trailing slash, once each', () => {
    process.env.MANTLE_API_CORS_ORIGINS = ` https://app.example.invalid/ ,,${DESKTOP}, http://localhost:3001`;
    expect(corsAllowlist()).toEqual([
      'https://app.example.invalid',
      DESKTOP,
      'http://localhost:3001',
    ]);
  });

  it("keeps the env '*' for the gate; namedCorsOrigins drops it", () => {
    process.env.MANTLE_API_CORS_ORIGINS = '*';
    expect(corsAllowlist()).toEqual(['*', DESKTOP]);
    expect(namedCorsOrigins()).toEqual([DESKTOP]);
  });
});
