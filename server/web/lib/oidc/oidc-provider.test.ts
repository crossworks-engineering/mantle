/**
 * The fresh sign-ins (provider.ts identityFromCallback): with the library's
 * token exchange stood in, an auth_time older than the flow's own start is
 * refused and a fresh one passes. A provider that sends none is let through
 * on a link (never strand anyone), and refused on a fresh sign-in, which
 * stands in for a password. A sign-in flow asks nothing of it. The real round
 * trip against a provider: server/web/scripts/oidc-flow-check.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ISSUER = 'https://idp.example.invalid/realms/company';
const h = vi.hoisted(() => ({ claims: {} as Record<string, unknown> }));

vi.mock('openid-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  discovery: async () => ({ serverMetadata: () => ({ issuer: ISSUER }) }),
  authorizationCodeGrant: async () => ({ claims: () => h.claims }),
}));

const NOW = Math.floor(Date.now() / 1000);
const flow = { state: 's', nonce: 'n', codeVerifier: 'v' };

beforeEach(() => {
  vi.stubEnv('MANTLE_OIDC_MODE', 'optional');
  vi.stubEnv('MANTLE_OIDC_ISSUER', ISSUER);
  vi.stubEnv('MANTLE_OIDC_CLIENT_ID', 'mantle');
  vi.stubEnv('MANTLE_PUBLIC_URL', 'https://brain.example.invalid');
});
afterEach(() => vi.unstubAllEnvs());

async function identity(
  claims: Record<string, unknown>,
  linkStartedAt?: number,
  freshStartedAt?: number,
) {
  h.claims = { iss: ISSUER, sub: 'sub-1', ...claims };
  const { identityFromCallback, forgetProviderConfig } = await import('./provider');
  const { oidcSettings } = await import('./settings');
  forgetProviderConfig();
  const s = oidcSettings();
  if (s.mode === 'off') throw new Error('test settings are off');
  return identityFromCallback(s, new URLSearchParams({ code: 'c', state: 's' }), flow, {
    ...(linkStartedAt === undefined ? {} : { linkStartedAt }),
    ...(freshStartedAt === undefined ? {} : { freshStartedAt }),
  });
}

describe("a link's sign-in at the provider", () => {
  it('is refused when the provider says it is older than the link', async () => {
    await expect(identity({ auth_time: NOW - 3600 }, NOW)).rejects.toThrow(/older than the flow/);
  });

  it('passes when it is fresh (within the clock skew too)', async () => {
    await expect(identity({ auth_time: NOW + 2 }, NOW)).resolves.toMatchObject({
      subject: 'sub-1',
    });
    await expect(identity({ auth_time: NOW - 30 }, NOW)).resolves.toMatchObject({
      subject: 'sub-1',
    });
  });

  it('passes when the provider sends no auth_time (asked, not proven)', async () => {
    await expect(identity({}, NOW)).resolves.toMatchObject({ subject: 'sub-1' });
  });

  it('a fresh sign-in must prove when it happened: no auth_time, no code', async () => {
    await expect(identity({}, undefined, NOW)).rejects.toThrow(/no auth_time/);
    await expect(identity({ auth_time: NOW - 3600 }, undefined, NOW)).rejects.toThrow(
      /older than the flow/,
    );
    await expect(identity({ auth_time: NOW + 2 }, undefined, NOW)).resolves.toMatchObject({
      subject: 'sub-1',
    });
  });

  it('a sign-in flow asks nothing of auth_time', async () => {
    await expect(identity({ auth_time: NOW - 86_400 })).resolves.toMatchObject({
      subject: 'sub-1',
    });
  });
});
